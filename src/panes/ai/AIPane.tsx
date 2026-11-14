// The AI Assistant pane (0.90.34 AIPaneView.swift `AIPaneView`, `AITranscriptView`, `AIMessageRow`,
// `AIToolCallRow`, `AIComposerTextView`; ledger §13.6, MENU-049, MENU-150, KEY-021…024): the header
// with the backend chip and the shared control order (Stop · Find · Export · code font · text
// size · Clear), the search row, the transcript or the starter panel / "no backend" state, and the
// composer. Conversations are per tab: the pane shows the front tab's, and a request in flight
// keeps writing to the tab it was asked in. Docked or detached, it reaches its document and
// window only through its own elements.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { AArrowDown, AArrowUp, ArrowDown, ArrowUp, Ban, ChevronRight, CircleCheck, CircleX, Ellipsis, LoaderCircle, Play, Search, Share, Sparkles, Trash2, TriangleAlert, Wrench, X } from "lucide-react";
import { Icon, StopIcon } from "../../components/Icon";
import { api } from "../../lib/api";
import { destructive } from "../../lib/dialogs";
import { setSettings, useSetting } from "../../lib/kv";
import { shortcutFor } from "../../lib/menu";
import { displayLabel } from "../../runs/ui/words";
import { liveRun } from "../../runs/ui/live";
import { useResults, useRunState } from "../../runs/state";
import { openSettings } from "../../windows/settings";
import { MONOSPACE_FAMILIES } from "../../windows/settings/rows";
import { useFocusTarget } from "../../workspace/focus";
import { focusPane } from "../../workspace/panes/commands";
import { PaneHeader } from "../../workspace/panes/PaneHeader";
import { useActiveTab } from "../../workspace/store";
import { asResult } from "../results/model";
import { Menu, type MenuItem } from "../status/popup";
import { writeClipboard } from "../status/state";
import { factFor } from "./explain/facts";
import { openFact, startersFor } from "./explain/open";
import { CodeWell, Markdown, Marked, type Citations, type ContextMenuOpener } from "./markdown";
import { ACTION_LABEL } from "./explain/guard";
import { allowAction, baseURLSetting, cancelRequest, clearConversation, continueToolLoop, conversationOf, draft, exchangeCount, modelSetting, requiresKey, resolvedProvider, setDraft, submit, useAi, type TranscriptMessage } from "./model";
import { copyConversation, durationOf, formatDuration, fullTime, saveTranscript, shortTime } from "./transcript";
import { aiWords as w } from "./words";
import "./ai.css";

export const FONT_KEY = "ai.fontSize";
export const FONT_NAME_KEY = "ai.fontName";
export const FONT_MIN = 8;
export const FONT_MAX = 28;
export const FONT_DEFAULT = 12;
/** `DS.Layout.headerCondenseWidthNarrow`: below it the font controls fold into one menu and the network badge hides. */
export const HEADER_CONDENSE_WIDTH = 380;
/** Exchanges above which Clear Conversation asks first. */
export const CLEAR_CONFIRM_EXCHANGES = 4;
/** The transcript follows new content while within this many points of its end. */
const PIN_SLACK = 32;
/** The pane takes the keyboard when it is shown, but not at launch (the canvas keeps it then). */
export const aiLaunch = { at: Date.now(), graceMs: 2000 };

export type BackendStatus = "busy" | "ready" | "missingKey" | "notConfigured";
const STATUS_ICON: Record<BackendStatus, LucideIcon> = { busy: LoaderCircle, ready: CircleCheck, missingKey: TriangleAlert, notConfigured: Ban };

/** One point bigger or smaller, within 8–28 (`increaseFontSize`, `decreaseFontSize`). */
export function stepAiFont(current: number, delta: 1 | -1): Promise<unknown> | undefined {
  const next = Math.min(FONT_MAX, Math.max(FONT_MIN, current + delta));
  return next === current ? undefined : setSettings({ [FONT_KEY]: next }).catch(() => {});
}

/** Whether a message is a search hit: its text, or a tool row's name, input or result. */
export function matches(m: TranscriptMessage, query: string): boolean {
  const q = query.toLocaleLowerCase();
  const has = (s: string | null | undefined) => !!s && s.toLocaleLowerCase().includes(q);
  return has(m.text) || (!!m.call && (has(m.call.name) || has(m.call.inputText) || has(m.call.result)));
}

function IconButton({ icon, label, help, onClick, disabled, danger, buttonRef }: { icon: LucideIcon; label: string; help: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; danger?: boolean; buttonRef?: React.Ref<HTMLButtonElement> }) {
  return (
    <button ref={buttonRef} type="button" className="icon-btn" data-danger={danger || undefined} aria-label={label} title={help} disabled={disabled} onClick={onClick}>
      <Icon icon={icon} size={14} aria-hidden />
    </button>
  );
}

function ToolRow({ m, q, onCopy, onMenu }: { m: TranscriptMessage; q: string; onCopy: (t: string) => void; onMenu: ContextMenuOpener }) {
  const [expanded, setExpanded] = useState(false);
  const call = m.call!;
  const running = call.finished === null;
  const d = durationOf(m);
  const duration = d === null ? null : formatDuration(d);
  const state = running ? "running" : call.isError ? "failed" : "completed";
  return (
    <div className="ai-tool" data-state={state} data-message={m.id} title={fullTime(m.timestamp)}>
      <button type="button" className="ai-tool-head" aria-expanded={expanded} aria-label={w.toolLabel(call.name, state)} title={running ? w.toolRunningHelp(call.name) : w.toolDoneHelp(call.name, call.isError, duration)} onClick={() => setExpanded(!expanded)}>
        <Icon icon={ChevronRight} size={12} className="ai-tool-chevron" />
        <span className="ai-tool-symbol"><Icon icon={running ? Wrench : call.isError ? CircleX : CircleCheck} size={14} /></span>
        <span className="ai-tool-name"><Marked text={call.name} q={q} /></span>
        {call.inputSummary ? <span className="ai-tool-summary"><Marked text={call.inputSummary} q={q} /></span> : null}
        <span className="spacer" />
        {running ? <span className="ai-spinner" role="progressbar" /> : duration ? <span className="ai-tool-duration">{duration}</span> : null}
      </button>
      {expanded ? (
        <div className="ai-tool-body">
          <div className="ai-tool-caption">{w.toolInput}</div>
          <CodeWell tool text={call.inputText} q={q} label={w.toolInputLabel(call.name)} onCopy={onCopy} onMenu={onMenu} />
          {call.result !== null ? (
            <>
              <div className="ai-tool-caption" data-error={call.isError || undefined}>{call.isError ? w.toolError : w.toolResult}</div>
              <CodeWell tool text={call.result} q={q} label={w.toolOutputLabel(call.isError ? w.toolError : w.toolResult, call.name)} onCopy={onCopy} onMenu={onMenu} />
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MessageRow({ m, q, tabId, current, onCopy, onMenu, onContinue }: { m: TranscriptMessage; q: string; tabId: string; current: boolean; onCopy: (t: string) => void; onMenu: ContextMenuOpener; onContinue: () => void }) {
  // A reply's handles are chips that open their source, and its unverified numbers are marked.
  const citations = useMemo<Citations | null>(() => (m.role === "assistant" ? { check: m.check ?? null, fact: (h) => factFor(tabId, h), open: (f) => void openFact(tabId, f) } : null), [m.role, m.check, tabId]);
  const flagged = m.check?.flagged.length ?? 0;
  const copyItem = (e: React.MouseEvent) => {
    e.stopPropagation();
    onMenu(e, [{ label: w.copyMessage, run: () => onCopy(m.text) }]);
  };
  const time = shortTime(m.timestamp);
  let body;
  if (m.role === "user")
    body = (
      <div className="ai-row ai-user" title={w.sent(fullTime(m.timestamp))}>
        <span className="ai-time" aria-hidden>{time}</span>
        <div className="ai-bubble" aria-label={w.youLabel(time, m.text)} onContextMenu={copyItem}><Marked text={m.text} q={q} /></div>
      </div>
    );
  else if (m.role === "assistant")
    body = (
      <div className="ai-row ai-assistant" title={w.received(fullTime(m.timestamp))}>
        <span className="ai-assistant-icon"><Icon icon={Sparkles} size={14} /></span>
        {m.isStreaming ? (
          <div className="ai-streaming" aria-label={w.assistantStreamingLabel(m.text)} onContextMenu={copyItem}>{m.text + " ▍"}</div>
        ) : (
          <div className="ai-reply" aria-label={w.assistantLabel(time, m.text)} onContextMenu={copyItem}>
            <Markdown text={m.text} q={q} onCopy={onCopy} onMenu={onMenu} citations={citations} />
            {flagged ? (
              <p className="ai-check" role="note" data-flagged={flagged}>
                <Icon icon={TriangleAlert} size={12} aria-hidden />
                <span>{w.checkSummary(flagged)}</span>
              </p>
            ) : null}
          </div>
        )}
        <span className="ai-time" aria-hidden>{time}</span>
      </div>
    );
  else if (m.role === "system")
    body = (
      <div className="ai-row ai-system" title={fullTime(m.timestamp)}>
        <div className="ai-system-text" data-warning={m.text.startsWith("⚠") || undefined} onContextMenu={copyItem}><Marked text={m.text} q={q} /></div>
        {m.action === "continueToolLoop" ? (
          <button type="button" className="btn ai-continue" title={w.continueHelp} aria-label={w.continueLabel} onClick={onContinue}>
            <Icon icon={Play} size={12} />
            {w.continue}
          </button>
        ) : m.action === "allowAction" && m.allow ? (
          <button type="button" className="btn ai-continue" title={w.allowHelp(ACTION_LABEL[m.allow] ?? m.allow)} aria-label={w.allowHelp(ACTION_LABEL[m.allow] ?? m.allow)} onClick={() => allowAction(tabId, m.allow!)}>
            <Icon icon={Play} size={12} />
            {w.allow(ACTION_LABEL[m.allow] ?? m.allow)}
          </button>
        ) : null}
      </div>
    );
  else body = <ToolRow m={m} q={q} onCopy={onCopy} onMenu={onMenu} />;
  return (
    <div className="ai-message" data-message={m.id} data-role={m.role} data-current={current || undefined}>
      {body}
    </div>
  );
}

export function AIPane() {
  const tab = useActiveTab();
  const tabId = tab.id;
  const ai = useAi();
  useRunState();
  const records = useResults(tabId);
  const starters = useMemo(() => startersFor({ hasNetwork: tab.document.nodes.length > 0, runs: records.map(asResult) }), [tab.document.nodes.length, records]);
  const conversation = conversationOf(tabId);
  const messages = conversation.messages;
  const fontSize = Number(useSetting<number>(FONT_KEY, FONT_DEFAULT)) || FONT_DEFAULT;
  const fontName = String(useSetting<string>(FONT_NAME_KEY, "") ?? "");
  const provider = resolvedProvider(useSetting<string>("ai.provider", "anthropic"));
  // Read through the hooks so a change in Settings re-renders the chip.
  useSetting<string>(`ai.model.${provider}`, "");
  useSetting<string>(`ai.baseURL.${provider}`, "");
  const modelName = modelSetting(provider).trim();
  const baseURL = baseURLSetting(provider).trim();

  const rootRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const exportRef = useRef<HTMLButtonElement>(null);
  const [keyPresent, setKeyPresent] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [width, setWidth] = useState(0);
  const [pinned, setPinned] = useState(true);
  const [menu, setMenu] = useState<{ x: number; y: number; label: string; items: MenuItem[]; anchor?: HTMLElement | null } | null>(null);
  const win = () => rootRef.current?.ownerDocument.defaultView ?? undefined;
  const doc = () => rootRef.current?.ownerDocument;

  const busyHere = ai.busyTabId === tabId;
  const busyElsewhere = ai.busyTabId !== null && ai.busyTabId !== tabId;
  const busy = ai.busyTabId !== null;
  const text = draft();

  // Whether a key is stored: asked on mount, on a provider change and when the window comes back
  // (from Settings), never per render (`refreshKeyPresence`).
  const refreshKey = useCallback(() => {
    void api.aiKeyStatus(provider).then(setKeyPresent, () => setKeyPresent(false));
  }, [provider]);
  useEffect(() => {
    refreshKey();
    const v = rootRef.current?.ownerDocument.defaultView;
    v?.addEventListener("focus", refreshKey);
    return () => v?.removeEventListener("focus", refreshKey);
  }, [refreshKey]);

  const status: BackendStatus = busyHere ? "busy" : !modelName || !baseURL ? "notConfigured" : requiresKey(provider) && !keyPresent ? "missingKey" : "ready";
  const configured = status === "busy" || status === "ready";
  const providerName = w.providerShort[provider];
  const showEmpty = !configured && !messages.some((m) => m.role === "user");
  const showStarter = !showEmpty && configured && messages.length === 0;

  const activeQuery = searching ? query.trim() : "";
  const visible = useMemo(() => (activeQuery ? messages.filter((m) => matches(m, activeQuery)) : messages), [messages, activeQuery]);
  const currentIndex = Math.min(matchIndex, Math.max(0, visible.length - 1));
  const currentMatchId = activeQuery && visible.length ? visible[currentIndex].id : null;
  const matchStatus = activeQuery && visible.length ? w.matchStatus(currentIndex + 1, visible.length) : null;

  // The measured width folds the header's least-used controls into one menu when narrow.
  useEffect(() => {
    const el = rootRef.current;
    const RO = el?.ownerDocument.defaultView?.ResizeObserver ?? globalThis.ResizeObserver;
    if (!el || !RO) return;
    const ro = new RO((es) => setWidth(es[0]?.contentRect.width ?? el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const condensed = width > 0 && width < HEADER_CONDENSE_WIDTH;

  // Follow new content only while the reader is at the end; a new tab opens at its end.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setPinned(true);
  }, [tabId]);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  });

  const focusComposer = useCallback(() => composerRef.current?.focus(), []);
  useEffect(() => {
    if (Date.now() - aiLaunch.at > aiLaunch.graceMs) focusComposer();
  }, [focusComposer]);

  // The composer grows from one line to six.
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text, fontSize]);

  const showSearch = useCallback(() => {
    setSearching(true);
    setTimeout(() => {
      searchRef.current?.focus();
      searchRef.current?.select();
    }, 0);
  }, []);
  const closeSearch = () => {
    setSearching(false);
    setQuery("");
    setMatchIndex(0);
    focusComposer();
  };

  // What the menu's handlers read when it calls them, rather than one render's copies.
  const live = useRef({ visible, activeQuery, matchIndex, fontSize });
  live.current = { visible, activeQuery, matchIndex, fontSize };
  const stepMatch = useCallback((delta: 1 | -1) => {
    const { visible: vis, matchIndex: at } = live.current;
    const total = vis.length;
    if (!total) return;
    const i = (Math.min(at, total - 1) + delta + total) % total;
    setMatchIndex(i);
    setPinned(false);
    listRef.current?.querySelector(`[data-message="${vis[i].id}"]`)?.scrollIntoView({ block: "center" });
  }, []);
  const zoom = useCallback((delta: 1 | -1) => void stepAiFont(live.current.fontSize, delta), []);

  useFocusTarget(
    "ai",
    {
      findTitle: w.findTitle,
      find: showSearch,
      stepFind: stepMatch,
      canStepFind: () => live.current.activeQuery !== "" && live.current.visible.length > 0,
      zoom,
      canZoom: (d) => (d > 0 ? live.current.fontSize < FONT_MAX : live.current.fontSize > FONT_MIN),
      focus: focusComposer,
    },
    [showSearch, stepMatch, zoom, focusComposer, searching, activeQuery, visible.length],
  );

  // ⌘. stops the request while no solver run owns that key (KEY-021); ⌥⌘, opens Settings ▸ AI
  // Assistant while the "no backend" state shows (KEY-024).
  useEffect(() => {
    const d = rootRef.current?.ownerDocument;
    if (!d) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && !e.altKey && !e.shiftKey && e.key === "." && busy && !liveRun()) {
        e.preventDefault();
        cancelRequest();
      } else if (e.metaKey && e.altKey && (e.key === "," || e.code === "Comma") && showEmpty) {
        e.preventDefault();
        openSettings("AI Assistant");
      }
    };
    d.addEventListener("keydown", onKey);
    return () => d.removeEventListener("keydown", onKey);
  }, [busy, showEmpty]);

  const copyText = (t: string) => void writeClipboard(t, win());
  const openMenu: ContextMenuOpener = (e, items) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, label: w.title, items });
  };
  const conversationItems: MenuItem[] = [
    { label: w.copyConversation, run: () => void copyConversation(tabId, win()) },
    { label: w.saveTranscript, run: () => void saveTranscript(tabId) },
  ];
  const fontItems = (): MenuItem[] => {
    const families = !fontName || MONOSPACE_FAMILIES.includes(fontName) ? MONOSPACE_FAMILIES : [fontName, ...MONOSPACE_FAMILIES];
    const mark = (on: boolean, label: string) => `${on ? "✓ " : "   "}${label}`;
    const pick = (f: string) => void setSettings({ [FONT_NAME_KEY]: f }).catch(() => {});
    return [{ label: mark(!fontName, w.systemMono), run: () => pick("") }, ...families.map((f): MenuItem => ({ label: mark(fontName === f, f), run: () => pick(f) }))];
  };
  const menuAt = (e: React.MouseEvent<HTMLElement>, label: string, items: MenuItem[]) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 4, label, items, anchor: e.currentTarget });
  };

  const send = () => {
    if (submit(tabId, draft())) setPinned(true);
  };
  const confirmClear = async () => {
    if (busyHere) return;
    const n = exchangeCount(tabId);
    if (n > CLEAR_CONFIRM_EXCHANGES) {
      const ok = await destructive({ title: w.clearAskTitle, message: w.clearAskMessage(n), confirmTitle: w.clearAskConfirm, target: doc() });
      if (!ok) return;
    }
    clearConversation(tabId);
  };

  const run = liveRun();
  const stopKey = shortcutFor("run:stop") ?? "⌘.";
  const stopHelp = `${busyElsewhere ? w.stopWhatElsewhere(ai.busyTabTitle) : w.stopWhat} (${run ? w.stopKeysDuringRun(stopKey, displayLabel(run.method) || w.theRun) : w.stopKeys(stopKey)})`;
  const chipText = status === "notConfigured" ? w.chipNotConfigured(providerName) : status === "missingKey" ? w.chipNoKey(providerName, modelName) : w.chip(providerName, modelName);
  const placeholder = !configured ? w.placeholderUnconfigured : busyElsewhere ? w.placeholderElsewhere(ai.busyTabTitle) : w.placeholder(tab.title);
  const sendHelp = busyElsewhere ? w.sendHelpElsewhere(ai.busyTabTitle) : busyHere ? w.sendHelpBusy : w.sendHelp;
  const showProgress = busyHere && !messages[messages.length - 1]?.isStreaming;

  let body;
  if (showEmpty)
    body = (
      <div className="empty-state ai-empty">
        <Icon icon={Sparkles} size={20} />
        <h2>{w.emptyTitle}</h2>
        <p>{status === "missingKey" ? w.emptyNeedsKey(providerName) : w.emptyChoose}</p>
        <button type="button" className="btn primary" title="⌥⌘," onClick={() => openSettings("AI Assistant")}>
          {w.openSettings}
        </button>
      </div>
    );
  else if (showStarter)
    body = (
      <div className="ai-starter" role="group" aria-label={w.starterLabel}>
        <span className="ai-starter-icon"><Icon icon={Sparkles} size={32} /></span>
        <h2>{w.starterTitle(modelName || providerName, tab.title)}</h2>
        <p>{w.starterMessage}</p>
        <div className="ai-starter-prompts">
          {starters.map((p) => (
            <button
              key={p}
              type="button"
              className="ai-starter-prompt"
              title={w.starterPromptHelp(p)}
              aria-label={w.starterPromptLabel(p)}
              onClick={() => {
                setDraft(p);
                focusComposer();
              }}
            >
              <span>{p}</span>
              <Icon icon={ChevronRight} size={12} />
            </button>
          ))}
        </div>
      </div>
    );
  else if (!visible.length)
    body = (
      <div className="empty-state ai-empty">
        <Icon icon={Search} size={20} />
        <h2>{w.noResults(query)}</h2>
        <p>{w.noResultsMessage}</p>
      </div>
    );
  else
    body = (
      <>
        <div
          ref={listRef}
          className="ai-transcript"
          role="log"
          aria-label={w.title}
          tabIndex={0}
          onScroll={(e) => {
            const el = e.currentTarget;
            const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_SLACK;
            if (atEnd !== pinned) setPinned(atEnd);
          }}
          onContextMenu={(e) => openMenu(e, conversationItems)}
        >
          {visible.map((m) => (
            <MessageRow key={m.id} m={m} q={activeQuery} tabId={tabId} current={m.id === currentMatchId} onCopy={copyText} onMenu={openMenu} onContinue={() => continueToolLoop(tabId)} />
          ))}
          {showProgress ? (
            <div className="ai-progress" aria-label={(ai.busyPhase || w.thinking).replace(/…$/, "")}>
              <span className="ai-spinner" role="progressbar" />
              <span>{ai.busyPhase || w.thinking}</span>
            </div>
          ) : null}
        </div>
        {!pinned ? (
          <button
            type="button"
            className="ai-scroll-latest"
            title={w.scrollToLatest}
            aria-label={w.scrollToLatest}
            onClick={() => {
              setPinned(true);
              const el = listRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
          >
            <Icon icon={ArrowDown} size={14} />
          </button>
        ) : null}
      </>
    );

  return (
    <section ref={rootRef} className="pane pane-ai ai-pane" data-pane="ai" tabIndex={-1} aria-label={w.title} style={{ ["--ai-fs" as string]: `${fontSize}px`, ["--ai-mono" as string]: fontName ? `"${fontName}", var(--mono)` : "var(--mono)" }}>
      <PaneHeader
        pane="ai"
        title={w.title}
        accessory={
          <>
            <button
              type="button"
              className="ai-chip"
              data-status={status}
              title={w.chipHelp(providerName, modelName || w.noModel, w.status[status])}
              aria-label={w.chipLabel(providerName, modelName || w.noModel, w.status[status])}
              onClick={() => openSettings("AI Assistant")}
            >
              <span className="ai-chip-dot"><Icon icon={STATUS_ICON[status]} size={12} /></span>
              <span className="ai-chip-text">{chipText}</span>
            </button>
            {!condensed ? (
              <span className="ai-badge" title={w.networkHelp(tab.title)} aria-label={w.networkLabel(tab.title)}>
                {tab.title}
              </span>
            ) : null}
            {busyElsewhere ? (
              <span className="ai-badge ai-badge-working" title={w.elsewhereHelp(ai.busyTabTitle)} aria-label={w.elsewhereLabel(ai.busyTabTitle)}>
                <Icon icon={LoaderCircle} size={12} />
                {w.elsewhere(ai.busyTabTitle)}
              </span>
            ) : null}
          </>
        }
      >
        <span className="ai-stop-slot" data-condensed={condensed || undefined}>
          {busy ? (
            <button type="button" className="ai-stop" title={stopHelp} aria-label={busyElsewhere ? w.stopLabelElsewhere(ai.busyTabTitle) : w.stopLabel} onClick={cancelRequest}>
              <Icon icon={StopIcon} size={14} />
              {condensed ? null : <span>{w.stop}</span>}
            </button>
          ) : null}
        </span>
        <IconButton icon={Search} label={w.search} help={w.searchHelp} disabled={!messages.length} onClick={showSearch} />
        <IconButton buttonRef={exportRef} icon={Share} label={w.exportLabel} help={w.exportHelp} disabled={exchangeCount(tabId) === 0} onClick={(e) => menuAt(e, w.exportLabel, conversationItems)} />
        {condensed ? (
          <IconButton
            icon={Ellipsis}
            label={w.more}
            help={w.moreHelp}
            onClick={(e) =>
              menuAt(e, w.more, [
                { label: w.bigger, disabled: fontSize >= FONT_MAX, run: () => zoom(1) },
                { label: w.smaller, disabled: fontSize <= FONT_MIN, run: () => zoom(-1) },
                "-",
                ...fontItems(),
              ])
            }
          />
        ) : (
          <>
            <button type="button" className="ai-font-menu" title={w.codeFontHelp} aria-label={`${w.codeFont}: ${fontName || w.systemMono}`} onClick={(e) => menuAt(e, w.codeFont, fontItems())}>
              {fontName || w.systemMono}
            </button>
            <span className="ai-stepper" role="group" aria-label={w.textSize}>
              <IconButton icon={AArrowDown} label={w.smaller} help={w.smaller} disabled={fontSize <= FONT_MIN} onClick={() => zoom(-1)} />
              <IconButton icon={AArrowUp} label={w.bigger} help={w.bigger} disabled={fontSize >= FONT_MAX} onClick={() => zoom(1)} />
            </span>
          </>
        )}
        <IconButton icon={Trash2} label={w.clear} help={busyHere ? w.clearHelpBusy : w.clearHelp} danger disabled={busyHere || !messages.length} onClick={() => void confirmClear()} />
      </PaneHeader>

      {searching ? (
        <div
          className="ai-search-row"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              closeSearch();
            }
          }}
        >
          <label className="ai-search" title={w.searchFieldHelp}>
            <Icon icon={Search} size={12} />
            <input
              ref={searchRef}
              type="text"
              value={query}
              placeholder={w.searchPlaceholder}
              aria-label={w.searchFieldLabel}
              aria-description={matchStatus ?? undefined}
              spellCheck={false}
              autoCorrect="off"
              onChange={(e) => {
                setQuery(e.target.value);
                setMatchIndex(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  stepMatch(1);
                }
              }}
            />
            {matchStatus ? <span className="ai-search-count" aria-hidden>{matchStatus}</span> : <span className="ai-search-count" aria-hidden>{query ? "" : w.searchHint}</span>}
          </label>
          <IconButton icon={X} label={w.closeSearch} help={w.closeSearchHelp} onClick={closeSearch} />
        </div>
      ) : null}

      <div className="ai-well-area">{body}</div>

      <div className="ai-composer">
        <textarea
          ref={composerRef}
          className="ai-composer-field"
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label={w.composerLabel}
          data-focus-default
          spellCheck
          autoCorrect="off"
          autoCapitalize="off"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              send();
            } else if (e.key === "Escape") {
              e.preventDefault();
              if (busyHere) cancelRequest();
              else focusPane("canvas");
            }
          }}
        />
        <button type="button" className="btn primary ai-send" title={sendHelp} aria-label={w.send} disabled={!text.trim() || busy} onClick={send}>
          <Icon icon={ArrowUp} size={14} />
        </button>
      </div>

      {menu ? <Menu x={menu.x} y={menu.y} label={menu.label} anchor={menu.anchor ?? null} items={menu.items} onClose={() => setMenu(null)} /> : null}
    </section>
  );
}
