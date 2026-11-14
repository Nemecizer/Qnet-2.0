// The Shell pane (ContentView.swift `TerminalPaneView`, shell.md §11.1; ledger SH-007…010,
// SH-040, SH-046…051, SH-061, SH-065…070): the header, the find bar, the context menu, and the
// body the terminal view (view.ts) is moved into. The view lives outside React; this component
// only shows it, so a remount (a maximize, a move into its own window) changes nothing in the shell.
import "@xterm/xterm/css/xterm.css";
import "./shell.css";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { AArrowDown, AArrowUp, ArrowDownToLine, Check, ChevronDown, ChevronUp, Copy, Ellipsis, RotateCcw, Search, Trash2, X } from "lucide-react";
import { Icon } from "../../components/Icon";
import { setSettings, useSetting } from "../../lib/kv";
import { shortcutFor } from "../../lib/menu";
import { useFocusTarget } from "../../workspace/focus";
import { PaneHeader } from "../../workspace/panes/PaneHeader";
import { addStatus } from "../../workspace/store";
import { MONOSPACE_FAMILIES } from "../../windows/settings/rows";
import { clearShell, confirmRestartShell, copyShellSelection, pasteIntoShell } from "./commands";
import { abbreviate, middleTruncate, DEFAULT_FONT, MAX_FONT, MIN_FONT, shellView, type ShellView } from "./view";
import { shellWords as w } from "./words";

/** `headerCondenseWidthWide`: below it the font controls fold into one menu. */
export const HEADER_CONDENSE_WIDTH = 560;
/** How long the Copy button shows its checkmark. */
export const COPIED_FLASH_MS = 1000;

/** One point bigger or smaller, within 8–28 (`setFontSize`). */
export function stepShellFont(current: number, delta: 1 | -1): Promise<unknown> | undefined {
  const next = Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(current) + delta));
  return next === current ? undefined : setSettings({ "shell.fontSize": next });
}

/** The home folder, for the header's ~ (Tauri's path API; the preview has none). */
let home: string | null = null;
const homeReady = import("@tauri-apps/api/path")
  .then((m) => m.homeDir())
  .then((h) => {
    home = h ? h.replace(/\/+$/, "") : null;
  })
  .catch(() => {});

function useHome(): string | null {
  const [h, setH] = useState(home);
  useEffect(() => {
    let live = true;
    void homeReady.then(() => live && setH(home));
    return () => {
      live = false;
    };
  }, []);
  return h;
}

function IconButton({ icon, label, help, onClick, disabled, danger }: { icon: LucideIcon; label: string; help: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button type="button" className="icon-btn" data-danger={danger || undefined} aria-label={label} title={help} disabled={disabled} onClick={onClick}>
      <Icon icon={icon} size={14} aria-hidden />
    </button>
  );
}

export type ShellMenuItem = "-" | { label: string; shortcut?: string; disabled?: boolean; checked?: boolean; run: () => void };

/** A menu at (x, y) in the shared context-menu style, with key equivalents shown. */
export function ShellMenu({ x, y, items, label, onClose }: { x: number; y: number; items: ShellMenuItem[]; label: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hi, setHi] = useState(-1);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    const win = el?.ownerDocument.defaultView;
    if (!el || !win) return;
    const left = Math.max(8, Math.min(x, win.innerWidth - el.offsetWidth - 8));
    const top = y + el.offsetHeight > win.innerHeight - 8 && y - el.offsetHeight > 8 ? y - el.offsetHeight : y;
    setPos({ left, top });
    el.focus();
  }, [x, y]);
  useEffect(() => {
    const doc = ref.current?.ownerDocument;
    if (!doc) return;
    const down = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    doc.addEventListener("mousedown", down, true);
    doc.addEventListener("keydown", key, true);
    return () => {
      doc.removeEventListener("mousedown", down, true);
      doc.removeEventListener("keydown", key, true);
    };
  }, [onClose]);
  const choose = (i: number) => {
    const it = items[i];
    if (!it || it === "-" || it.disabled) return;
    onClose();
    it.run();
  };
  const move = (d: 1 | -1) => {
    for (let k = 1, i = hi; k <= items.length; k++) {
      i = (i + d + items.length) % items.length;
      const it = items[i];
      if (it !== "-" && !it.disabled) return setHi(i);
    }
  };
  return (
    <div
      ref={ref}
      className="ctx-menu shell-menu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") move(1);
        else if (e.key === "ArrowUp") move(-1);
        else if (e.key === "Enter" || e.key === " ") choose(hi);
        else return;
        e.preventDefault();
      }}
    >
      {items.map((it, i) =>
        it === "-" ? (
          <div key={i} className="ctx-sep" role="separator" />
        ) : (
          <div
            key={i}
            role={it.checked === undefined ? "menuitem" : "menuitemradio"}
            aria-checked={it.checked}
            aria-disabled={it.disabled || undefined}
            className={`ctx-item${i === hi ? " hi" : ""}${it.disabled ? " disabled" : ""}`}
            onMouseEnter={() => setHi(i)}
            onMouseLeave={() => setHi(-1)}
            onClick={() => choose(i)}
          >
            {it.checked !== undefined ? <span className="ctx-check">{it.checked ? <Icon icon={Check} size={12} aria-hidden /> : null}</span> : null}
            <span className="ctx-label">{it.label}</span>
            {it.shortcut ? <span className="ctx-shortcut">{it.shortcut}</span> : null}
          </div>
        ),
      )}
    </div>
  );
}

function FindBar({ view }: { view: ShellView }) {
  const s = useSyncExternalStore(view.subscribe, view.snapshot);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (s.findOpen) {
      input.current?.focus();
      input.current?.select();
    }
  }, [s.findOpen]);
  if (!s.findOpen) return null;
  return (
    <div className="shell-find" role="search" aria-label={w.findField}>
      <Icon icon={Search} size={12} aria-hidden />
      <input
        ref={input}
        type="search"
        className="shell-find-field"
        aria-label={w.findField}
        placeholder={w.findPlaceholder}
        value={s.findTerm}
        data-missed={s.findMissed || undefined}
        onChange={(e) => view.setFindTerm(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") view.findStep(e.shiftKey ? -1 : 1);
          else if (e.key === "Escape") view.closeFind();
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      />
      {s.findMissed && s.findTerm ? <span className="shell-find-none">{w.noMatches}</span> : null}
      <IconButton icon={ChevronUp} label={w.findPrevious} help={w.findPreviousHelp} disabled={!s.findTerm} onClick={() => view.findStep(-1)} />
      <IconButton icon={ChevronDown} label={w.findNext} help={w.findNextHelp} disabled={!s.findTerm} onClick={() => view.findStep(1)} />
      <IconButton icon={X} label={w.findClose} help={w.findCloseHelp} onClick={() => view.closeFind()} />
    </div>
  );
}

/** The header's Copy (`copyFromShell`): the selection, or the whole scrollback — and it says which. */
export async function copyFromShell(view: ShellView): Promise<boolean> {
  const sel = view.selection();
  const text = sel || view.scrollbackText();
  if (!text) {
    addStatus(w.nothingToCopy, "warning");
    return false;
  }
  const { writeClipboard } = await import("../status/state");
  await writeClipboard(text, view.root.ownerDocument.defaultView ?? window);
  const n = [...text].length;
  addStatus(sel ? w.copiedSelection(n) : w.copiedAll(n), "success");
  return true;
}

export function ShellPane() {
  const view = shellView();
  const s = useSyncExternalStore(view.subscribe, view.snapshot);
  const body = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const fontSize = Number(useSetting<number>("shell.fontSize", DEFAULT_FONT)) || DEFAULT_FONT;
  const fontName = useSetting<string>("shell.fontName", "");
  const classic = useSetting<boolean>("shell.classicTheme", false);
  const [width, setWidth] = useState(1200);
  const [menu, setMenu] = useState<{ kind: "context" | "more" | "font"; x: number; y: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const homeFolder = useHome();
  const fontRef = useRef(fontSize);
  fontRef.current = fontSize;

  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    view.attach(el);
    void view.start();
    return () => view.detach(el);
  }, [view]);

  useEffect(() => {
    view.applySettings({ fontSize, fontName: typeof fontName === "string" ? fontName : "", classic: !!classic });
  }, [view, fontSize, fontName, classic]);

  useEffect(() => {
    const el = section.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const wdt = entries[0]?.contentRect.width;
      if (wdt) setWidth(wdt);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const zoom = useCallback((d: 1 | -1) => void stepShellFont(fontRef.current, d), []);
  useFocusTarget(
    "shell",
    {
      findTitle: w.findTitle,
      find: () => view.showFind(),
      stepFind: (d) => void view.findStep(d),
      canStepFind: () => !!view.snapshot().findTerm,
      zoom,
      canZoom: (d) => (d > 0 ? fontRef.current < MAX_FONT : fontRef.current > MIN_FONT),
      focus: () => view.focus(),
    },
    [view, zoom],
  );

  const copy = async () => {
    if (await copyFromShell(view)) {
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_FLASH_MS);
    }
  };

  const path = s.cwd;
  const shown = middleTruncate(abbreviate(path, homeFolder));
  const findKey = shortcutFor("edit:find") ?? "⌘F";
  const clearKey = shortcutFor("shell:clear") ?? "⌘K";
  const condensed = width < HEADER_CONDENSE_WIDTH;
  const doc = () => section.current?.ownerDocument;

  const families = MONOSPACE_FAMILIES.includes(fontName) || !fontName ? MONOSPACE_FAMILIES : [fontName, ...MONOSPACE_FAMILIES];
  const setFamily = (f: string) => void setSettings({ "shell.fontName": f });

  const contextItems: ShellMenuItem[] = [
    { label: w.ctxCopy, shortcut: "⌘C", disabled: !view.term.hasSelection(), run: () => void copyShellSelection() },
    { label: w.ctxPaste, shortcut: "⌘V", run: () => void pasteIntoShell() },
    { label: w.ctxSelectAll, shortcut: "⌘A", run: () => view.selectAll() },
    "-",
    { label: w.ctxFind, shortcut: "⌘F", run: () => view.showFind() },
    { label: w.ctxScrollToBottom, disabled: !s.canScroll, run: () => view.scrollToBottom() },
    "-",
    { label: w.ctxClear, shortcut: "⌘K", run: clearShell },
  ];
  const fontItems: ShellMenuItem[] = [
    { label: w.systemMono, checked: !fontName, run: () => setFamily("") },
    ...families.map((f): ShellMenuItem => ({ label: f, checked: fontName === f, run: () => setFamily(f) })),
  ];
  const moreItems: ShellMenuItem[] = [
    { label: w.bigger, disabled: fontSize >= MAX_FONT, run: () => zoom(1) },
    { label: w.smaller, disabled: fontSize <= MIN_FONT, run: () => zoom(-1) },
    "-",
    ...fontItems,
  ];

  let fontControls: ReactNode;
  if (condensed) {
    fontControls = (
      <button
        type="button"
        className="icon-btn"
        aria-label={w.more}
        title={w.moreHelp}
        aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ kind: "more", x: r.left, y: r.bottom + 4 });
        }}
      >
        <Icon icon={Ellipsis} size={14} aria-hidden />
      </button>
    );
  } else {
    fontControls = (
      <>
        <button
          type="button"
          className="shell-font-menu"
          title={w.fontMenuHelp}
          aria-label={`${w.fontMenuHelp}: ${fontName || w.systemMono}`}
          aria-haspopup="menu"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ kind: "font", x: r.left, y: r.bottom + 4 });
          }}
        >
          {fontName || w.systemMono}
        </button>
        <IconButton icon={AArrowDown} label={w.smaller} help={w.smallerHelp} disabled={fontSize <= MIN_FONT} onClick={() => zoom(-1)} />
        <IconButton icon={AArrowUp} label={w.bigger} help={w.biggerHelp} disabled={fontSize >= MAX_FONT} onClick={() => zoom(1)} />
      </>
    );
  }

  const leading = (
    <div className="shell-header-info">
      <span className="shell-dot" data-running={s.running || !s.started || undefined} role="img" aria-label={s.running || !s.started ? w.running : w.exited} title={s.running || !s.started ? w.running : w.exited} />
      <span className="shell-path" title={path ? w.directoryHelp(path) : undefined} aria-label={path ? w.directoryLabel(path) : undefined}>
        {shown}
      </span>
      {s.started && !s.running ? (
        <button type="button" className="shell-restart-now" title={w.restartNowHelp} aria-label={w.restartNowLabel} onClick={() => void view.restart()}>
          {w.restartNow}
        </button>
      ) : null}
    </div>
  );

  return (
    <section ref={section} className="pane pane-shell" data-pane="shell" tabIndex={-1} aria-label={w.title}>
      <PaneHeader pane="shell" accessory={leading}>
        <IconButton icon={ArrowDownToLine} label={w.scrollToBottom} help={w.scrollToBottomHelp} onClick={() => view.scrollToBottom()} />
        <IconButton icon={Search} label={w.find} help={w.findHelp(findKey)} onClick={() => view.showFind()} />
        <IconButton icon={copied ? Check : Copy} label={copied ? w.copied : w.copy} help={w.copyHelp} onClick={() => void copy()} />
        {fontControls}
        <IconButton icon={Trash2} label={w.clear} help={w.clearHelp(clearKey)} danger onClick={() => view.clear()} />
        <IconButton icon={RotateCcw} label={w.restart} help={w.restartHelp} danger onClick={() => void confirmRestartShell(doc())} />
      </PaneHeader>
      <div
        className="shell-frame"
        onContextMenu={(e) => {
          e.preventDefault();
          if (view.mouseReporting() || (e.target as Element).closest?.(".shell-find")) return;
          setMenu({ kind: "context", x: e.clientX, y: e.clientY });
        }}
      >
        <div ref={body} className="shell-body" />
        <FindBar view={view} />
      </div>
      {menu ? (
        <ShellMenu
          x={menu.x}
          y={menu.y}
          label={menu.kind === "more" ? w.more : menu.kind === "font" ? w.shellFont : w.title}
          items={menu.kind === "more" ? moreItems : menu.kind === "font" ? fontItems : contextItems}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </section>
  );
}
