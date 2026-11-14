// In-page popovers and menus for the Status pane (the flag bar's popovers, the Export menu, the
// list's context menu). Each is drawn in the document of the element it belongs to, so it works
// the same docked or detached (an auxiliary window renders this tree into another document), and
// closes on Escape and on a click outside it.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Calls `onClose` on Escape or a pointer press outside `inside` (and `anchor`), in their document. */
export function useDismiss(inside: React.RefObject<HTMLElement | null>, anchor: HTMLElement | null, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const doc = inside.current?.ownerDocument ?? anchor?.ownerDocument;
    if (!doc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close.current();
      }
    };
    const onDown = (e: Event) => {
      const t = e.target as Node | null;
      if (t && (inside.current?.contains(t) || anchor?.contains(t))) return;
      close.current();
    };
    doc.addEventListener("keydown", onKey, true);
    doc.addEventListener("mousedown", onDown, true);
    return () => {
      doc.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("mousedown", onDown, true);
    };
  }, [inside, anchor]);
}

/** Keeps a fixed box at (x, y) inside its window. */
function useFit(ref: React.RefObject<HTMLElement | null>, x: number, y: number) {
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    const win = el?.ownerDocument.defaultView;
    if (!el || !win) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(x, win.innerWidth - w - 8));
    const top = y + h > win.innerHeight - 8 && y - h > 8 ? y - h : y;
    setPos({ left, top });
  }, [ref, x, y]);
  return pos;
}

/** A popover under `anchor` (0.90.34's DSPopover: a title row with an icon and a trailing word, then the body). */
export function Popover({ anchor, onClose, label, header, children }: { anchor: HTMLElement; onClose: () => void; label: string; header?: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, anchor, onClose);
  const r = anchor.getBoundingClientRect();
  const pos = useFit(ref, r.left, r.bottom + 6);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div ref={ref} className="status-popover" role="dialog" aria-label={label} tabIndex={-1} style={{ left: pos.left, top: pos.top }}>
      {header ? <div className="status-popover-head">{header}</div> : null}
      <div className="status-popover-body">{children}</div>
    </div>
  );
}

export type MenuItem = { label: string; disabled?: boolean; danger?: boolean; run: () => void } | "-";

/** A menu at (x, y), drawn with the shared context-menu styles; arrows move, Return chooses. */
export function Menu({ x, y, items, onClose, label, anchor = null }: { x: number; y: number; items: MenuItem[]; onClose: () => void; label: string; anchor?: HTMLElement | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hi, setHi] = useState(-1);
  useDismiss(ref, anchor, onClose);
  const pos = useFit(ref, x, y);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const choose = (i: number) => {
    const it = items[i];
    if (!it || it === "-" || it.disabled) return;
    onClose();
    it.run();
  };
  const move = (d: 1 | -1) => {
    const n = items.length;
    for (let k = 1, i = hi; k <= n; k++) {
      i = (i + d + n) % n;
      const it = items[i];
      if (it !== "-" && !it.disabled) return setHi(i);
    }
  };
  return (
    <div
      ref={ref}
      className="ctx-menu status-menu"
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
            role="menuitem"
            aria-disabled={it.disabled || undefined}
            className={`ctx-item${i === hi ? " hi" : ""}${it.danger ? " danger" : ""}${it.disabled ? " disabled" : ""}`}
            onMouseEnter={() => setHi(i)}
            onMouseLeave={() => setHi(-1)}
            onClick={() => choose(i)}
          >
            <span className="ctx-label">{it.label}</span>
          </div>
        ),
      )}
    </div>
  );
}
