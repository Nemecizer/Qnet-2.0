// The document tab bar above the canvas (0.90.34 ContentView.swift `TabBarView`, `TabItemView`;
// ledger 5.2). Every close goes through closing.ts's guarded `closeTabs`; this only decides which.
//
// Reordering uses pointer events, not HTML drag and drop, so nothing from outside (a Finder file,
// a line of text) can be dropped on the strip and a dragged tab carries nothing to other apps
// (WS-024: 0.90.34's private drag type did the same).
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { shortcutFor } from "../../lib/menu";
import { addTab, getWorkspace, isDirty, moveTab, selectTab, useWorkspace, type Tab } from "../store";
import { closeOtherTabs, closeTabs, closeTabsToTheRight, showAdjacentTab } from "./closing";
import { useSessionReady } from "./session";
import { tabWords } from "./words";
import "./tabs.css";

/** 0.90.34 `DS.Layout.tabMaxTitleWidth`. */
export const TAB_MAX_TITLE_WIDTH = 220;
/** How far the pointer moves before a press on a tab becomes a drag. */
const DRAG_SLOP = 4;

const key = (id: string, fallback: string) => shortcutFor(id) ?? fallback;

let measureCtx: CanvasRenderingContext2D | null | undefined;

/** `text` cut in the middle with "…" to fit `max` px in `font` (SwiftUI `.truncationMode(.middle)`). */
export function middleTruncate(text: string, max: number, measure: (s: string) => number): string {
  if (measure(text) <= max) return text;
  let lo = 0;
  let hi = text.length;
  const cut = (n: number) => text.slice(0, Math.ceil(n / 2)) + "…" + text.slice(text.length - Math.floor(n / 2));
  // The most characters kept that still fit.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(cut(mid)) <= max) lo = mid;
    else hi = mid - 1;
  }
  return cut(lo);
}

function useMiddleTruncated(text: string, el: HTMLElement | null): string {
  const [out, setOut] = useState(text);
  useLayoutEffect(() => {
    if (!el) return setOut(text);
    if (measureCtx === undefined) {
      // jsdom has no canvas; there the CSS ellipsis stands in.
      if (/jsdom/i.test(navigator.userAgent)) measureCtx = null;
      else try {
        measureCtx = document.createElement("canvas").getContext("2d");
      } catch {
        measureCtx = null;
      }
    }
    const ctx = measureCtx;
    if (!ctx) return setOut(text);
    const cs = getComputedStyle(el);
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    setOut(middleTruncate(text, TAB_MAX_TITLE_WIDTH, (s) => ctx.measureText(s).width));
  }, [text, el, el?.dataset.active]);
  return out;
}

interface Drag {
  id: string;
  startX: number;
  moved: boolean;
  /** The tab it will land before, or "end". */
  target: string | null;
}

/** The tab bar (WS-017…027). */
export function TabBar() {
  const tabs = useWorkspace((ws) => ws.tabs);
  const activeId = useWorkspace((ws) => ws.activeId);
  const ready = useSessionReady();
  const strip = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  // WS-025: the arrows show only while the tabs overflow the strip.
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const END_ZONE = 32;
    const check = () => setOverflow(el.clientWidth > 0 && el.scrollWidth - END_ZONE > el.clientWidth + 0.5);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabs.length, ready]);

  // WS-026: the active tab is scrolled into view when it changes and when the bar first appears.
  useEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeId)}"]`);
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeId, ready]);

  const setDragState = (d: Drag | null) => {
    dragRef.current = d;
    setDrag(d);
  };

  /** Which tab a drop at `x` lands before (WS-023): the tab under the pointer, or the end. */
  const targetAt = (x: number, dragged: string): string | null => {
    const items = [...(strip.current?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? [])];
    for (const it of items) {
      const r = it.getBoundingClientRect();
      if (x >= r.left && x < r.right) return it.dataset.tabId === dragged ? null : (it.dataset.tabId ?? null);
    }
    const last = items[items.length - 1]?.getBoundingClientRect();
    if (last && x >= last.right) return "end";
    return null;
  };

  const onPointerDown = (e: ReactPointerEvent, id: string) => {
    if (e.button === 1) {
      // WS-021: a middle click closes, through the same guard.
      e.preventDefault();
      void closeTabs([id]);
      return;
    }
    if (e.button !== 0 || (e.target as HTMLElement).closest(".tab-close")) return;
    setDragState({ id, startX: e.clientX, moved: false, target: null });
    try {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      // A synthetic event has no pointer to capture.
    }
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const moved = d.moved || Math.abs(e.clientX - d.startX) > DRAG_SLOP;
    if (!moved) return;
    const target = targetAt(e.clientX, d.id);
    if (moved !== d.moved || target !== d.target) setDragState({ ...d, moved, target });
  };

  const onPointerUp = (e: ReactPointerEvent, id: string) => {
    const d = dragRef.current;
    setDragState(null);
    if (!d || e.button !== 0) return;
    if (!d.moved) {
      selectTab(id);
      return;
    }
    dropOn(d.id, d.target);
  };

  return (
    <div className="tabbar">
      <ArrowButton dir="previous" visible={overflow} disabled={!overflow || tabs.length < 2} />
      <div className="tabbar-strip" ref={strip} role="tablist" aria-label={tabWords.tabBarLabel}>
        {tabs.map((t) => (
            <TabItem
              key={t.id}
              tab={t}
              active={t.id === activeId}
              dragging={!!drag?.moved && drag.id === t.id}
              dropTarget={!!drag?.moved && drag.target === t.id}
              onPointerDown={(e) => onPointerDown(e, t.id)}
              onPointerMove={onPointerMove}
              onPointerUp={(e) => onPointerUp(e, t.id)}
              onPointerCancel={() => setDragState(null)}
              onContextMenu={(x, y) => setMenu({ id: t.id, x, y })}
            />
        ))}
        <div className={"tabbar-end" + (drag?.moved && drag.target === "end" ? " is-drop-target" : "")} aria-hidden="true" />
      </div>
      <ArrowButton dir="next" visible={overflow} disabled={!overflow || tabs.length < 2} />
      <button
        type="button"
        className="tabbar-button"
        aria-label={tabWords.newNetwork}
        title={tabWords.newNetworkHelp(key("file:new", "⌘N"))}
        onClick={() => addTab()}
      >
        <Plus size={14} aria-hidden="true" />
      </button>
      {menu && <TabContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** Moves the dragged tab to just before `target`, or to the end (0.90.34 `moveTab`, `moveTabToEnd`). */
export function dropOn(dragged: string, target: string | null, tabs: Tab[] = getTabs()) {
  if (!target || target === dragged) return;
  const from = tabs.findIndex((t) => t.id === dragged);
  if (from < 0) return;
  if (target === "end") {
    if (from !== tabs.length - 1) moveTab(dragged, tabs.length - 1);
    return;
  }
  const to = tabs.findIndex((t) => t.id === target);
  if (to < 0) return;
  moveTab(dragged, from < to ? to - 1 : to);
}

const getTabs = () => getWorkspace().tabs;

function ArrowButton({ dir, visible, disabled }: { dir: "previous" | "next"; visible: boolean; disabled: boolean }) {
  const prev = dir === "previous";
  const label = prev ? tabWords.previousTab : tabWords.nextTab;
  const help = prev ? tabWords.previousTabHelp(key("window:previous-tab", "⇧⌘[")) : tabWords.nextTabHelp(key("window:next-tab", "⇧⌘]"));
  return (
    <button
      type="button"
      className={"tabbar-button tabbar-arrow" + (visible ? "" : " is-hidden")}
      aria-label={label}
      aria-hidden={visible ? undefined : true}
      tabIndex={visible ? undefined : -1}
      title={help}
      disabled={disabled}
      onClick={() => showAdjacentTab(prev ? -1 : 1)}
    >
      {prev ? <ChevronLeft size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
    </button>
  );
}

interface TabItemProps {
  tab: Tab;
  active: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerUp: (e: ReactPointerEvent) => void;
  onPointerCancel: () => void;
  onContextMenu: (x: number, y: number) => void;
}

function TabItem({ tab, active, dragging, dropTarget, onContextMenu, ...pointer }: TabItemProps) {
  const [hover, setHover] = useState(false);
  const [titleEl, setTitleEl] = useState<HTMLSpanElement | null>(null);
  const dirty = isDirty(tab);
  const shown = useMiddleTruncated(tab.title, titleEl);
  const closeKey = key("file:close-tab", "⌘W");
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      showAdjacentTab(e.key === "ArrowRight" ? 1 : -1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      selectTab(tab.id);
    }
  };
  return (
    <div
      role="tab"
      data-tab-id={tab.id}
      aria-selected={active}
      aria-label={tabWords.tabLabel(tab.title, dirty)}
      tabIndex={active ? 0 : -1}
      className={"tab" + (active ? " is-active" : "") + (dragging ? " is-dragging" : "") + (dropTarget ? " is-drop-target" : "") + (dirty ? " is-dirty" : "")}
      title={tab.path ?? tabWords.unsavedNetwork}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onAuxClick={(e) => e.button === 1 && e.preventDefault()}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
      onKeyDown={onKeyDown}
      {...pointer}
    >
      <span className="tab-title" ref={setTitleEl} data-active={active ? "" : undefined}>
        {shown}
      </span>
      <span className="tab-slot">
        {hover ? (
          <button
            type="button"
            className="tab-close"
            aria-label={tabWords.closeTabLabel(tab.title)}
            title={dirty ? tabWords.closeDirtyHelp(closeKey) : tabWords.closeCleanHelp(closeKey, key("window:reopen-tab", "⇧⌘T"))}
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              void closeTabs([tab.id]);
            }}
          >
            <X size={11} aria-hidden="true" />
          </button>
        ) : dirty ? (
          <span className="tab-dot" role="img" aria-label={tabWords.unsavedChanges} />
        ) : null}
      </span>
    </div>
  );
}

/** WS-022: Close Tab, Close Other Tabs, Close Tabs to the Right, and Reveal in Finder (dimmed with no file). */
function TabContextMenu({ id, x, y, onClose }: { id: string; x: number; y: number; onClose: () => void }) {
  const tab = useWorkspace((ws) => ws.tabs.find((t) => t.id === id));
  const ref = useRef<HTMLDivElement>(null);
  const [hi, setHi] = useState(0);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  if (!tab) return null;
  const items: { label: string; run: () => unknown; disabled?: boolean; sepBefore?: boolean }[] = [
    { label: tabWords.closeTab, run: () => closeTabs([id]) },
    { label: tabWords.closeOtherTabs, run: () => closeOtherTabs(id) },
    { label: tabWords.closeTabsToTheRight, run: () => closeTabsToTheRight(id) },
    { label: tabWords.revealInFinder, run: () => tab.path && revealItemInDir(tab.path).catch(() => {}), disabled: tab.path === null, sepBefore: true },
  ];
  const choose = (i: number) => {
    const it = items[i];
    if (!it || it.disabled) return;
    onClose();
    void it.run();
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => (h + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(hi);
    }
  };
  return createPortal(
    <div className="ctx-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()} onContextMenu={(e) => e.preventDefault()}>
      <div className="ctx-menu" role="menu" ref={ref} tabIndex={-1} style={{ left: x, top: y }} onKeyDown={onKeyDown}>
        {items.map((it, i) => (
          <div key={it.label}>
            {it.sepBefore && <div className="ctx-sep" role="separator" />}
            <div
              role="menuitem"
              aria-disabled={it.disabled || undefined}
              className={"ctx-item" + (i === hi ? " hi" : "") + (it.disabled ? " disabled" : "")}
              onMouseEnter={() => setHi(i)}
              onClick={() => choose(i)}
            >
              <span className="ctx-label">{it.label}</span>
            </div>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
