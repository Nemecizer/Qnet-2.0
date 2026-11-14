// A pull-down menu for the top bar's Workspace button, copied from NetMon's ContextMenuHost and
// trimmed (no admin locks): arrows, Home/End, Enter/Space, Escape, type-ahead, submenus that open
// beside their row, and a tooltip per item (0.90.34's `.help`). Styled by components/shell.css's
// `.ctx-*` classes.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight } from "lucide-react";

export type PopupItem =
  | "-"
  | { label: string; help?: string; disabled?: boolean; checked?: boolean; run?: () => void; submenu?: PopupItem[] };

const isSep = (i: PopupItem): i is "-" => i === "-";
const isOff = (i: PopupItem) => isSep(i) || !!i.disabled;

export interface PopupMenuProps {
  items: PopupItem[];
  anchor: DOMRect;
  /** Closes the menu; `chosen` runs after focus has gone back where it was. */
  onClose: (chosen?: () => void) => void;
  label: string;
}

export function PopupMenu({ items, anchor, onClose, label }: PopupMenuProps) {
  return createPortal(
    <div className="ctx-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()} onContextMenu={(e) => (e.preventDefault(), onClose())}>
      <MenuList items={items} x={anchor.right} y={anchor.bottom + 2} alignRight anchorLeft={anchor.left} onClose={onClose} depth={0} label={label} />
    </div>,
    document.body,
  );
}

function MenuList({ items, x, y, alignRight, anchorLeft, flipX, onClose, onBack, depth, label }: {
  items: PopupItem[];
  x: number;
  y: number;
  alignRight?: boolean;
  anchorLeft?: number;
  flipX?: number;
  onClose: (chosen?: () => void) => void;
  onBack?: () => void;
  depth: number;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [hi, setHi] = useState(depth > 0 ? firstEnabled(items, 0, 1) : -1);
  const [open, setOpen] = useState<number | null>(null);
  const typed = useRef({ text: "", at: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nx = alignRight ? x - r.width : x;
    if (nx < 4 && anchorLeft !== undefined) nx = anchorLeft;
    if (nx + r.width > vw - 4) nx = flipX !== undefined ? flipX - r.width : vw - r.width - 4;
    const ny = y + r.height > vh - 4 ? Math.max(4, vh - r.height - 4) : y;
    setPos({ x: Math.max(4, nx), y: ny });
  }, [x, y]);

  useEffect(() => ref.current?.focus({ preventScroll: true }), []);

  const activate = (i: number) => {
    const item = items[i];
    if (!item || isOff(item) || isSep(item)) return;
    if (item.submenu) return setOpen(i);
    onClose(item.run);
  };

  const onKey = (e: ReactKeyboardEvent) => {
    if (open !== null) return;
    const k = e.key;
    if (k === "ArrowDown" || k === "ArrowUp") {
      e.preventDefault();
      setHi((h) => firstEnabled(items, h + (k === "ArrowDown" ? 1 : -1), k === "ArrowDown" ? 1 : -1));
    } else if (k === "Home" || k === "End") {
      e.preventDefault();
      setHi(firstEnabled(items, k === "Home" ? 0 : items.length - 1, k === "Home" ? 1 : -1));
    } else if (k === "Enter" || k === " ") {
      e.preventDefault();
      if (hi >= 0) activate(hi);
    } else if (k === "ArrowRight") {
      e.preventDefault();
      const it = items[hi];
      if (hi >= 0 && !isSep(it) && it.submenu && !it.disabled) setOpen(hi);
    } else if (k === "ArrowLeft" || k === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (onBack) onBack();
      else if (k === "Escape") onClose();
    } else if (k === "Tab") {
      e.preventDefault();
    } else if (k.length === 1 && !e.metaKey && !e.ctrlKey) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : "") + k.toLowerCase(), at: now };
      const t = typed.current.text;
      const from = t.length > 1 ? Math.max(hi, 0) : hi + 1;
      for (let j = 0; j < items.length; j++) {
        const i = (((from + j) % items.length) + items.length) % items.length;
        const it = items[i];
        if (!isOff(it) && !isSep(it) && it.label.toLowerCase().startsWith(t)) {
          setHi(i);
          break;
        }
      }
    }
  };

  const hasChecks = items.some((i) => !isSep(i) && i.checked !== undefined);

  return (
    <div ref={ref} className="ctx-menu" role="menu" aria-label={label} tabIndex={-1} style={{ left: pos.x, top: pos.y }} onKeyDown={onKey} aria-activedescendant={hi >= 0 ? `wsm-${depth}-${hi}` : undefined}>
      {items.map((item, i) => {
        if (isSep(item)) return <div key={`sep-${i}`} className="ctx-sep" role="separator" />;
        const sub = !!item.submenu;
        return (
          <div
            key={`${item.label}-${i}`}
            id={`wsm-${depth}-${i}`}
            role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
            aria-checked={item.checked}
            aria-disabled={item.disabled || undefined}
            aria-haspopup={sub ? "menu" : undefined}
            aria-expanded={sub ? open === i : undefined}
            className={`ctx-item${i === hi ? " hi" : ""}${item.disabled ? " disabled" : ""}`}
            title={item.help}
            onPointerEnter={() => {
              setHi(i);
              setOpen(sub && !item.disabled ? i : null);
            }}
            onClick={() => activate(i)}
          >
            {hasChecks && <span className="ctx-check">{item.checked && <Check size={12} aria-hidden />}</span>}
            <span className="ctx-label">{item.label}</span>
            {sub && <ChevronRight size={12} className="ctx-more" aria-hidden />}
            {sub && open === i && (
              <SubMenu
                items={item.submenu!}
                depth={depth + 1}
                onClose={onClose}
                onBack={() => {
                  setOpen(null);
                  ref.current?.focus({ preventScroll: true });
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function SubMenu({ items, depth, onClose, onBack }: { items: PopupItem[]; depth: number; onClose: (chosen?: () => void) => void; onBack: () => void }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState<{ x: number; y: number; flipX: number } | null>(null);
  useLayoutEffect(() => {
    const row = anchor.current?.parentElement?.getBoundingClientRect();
    if (row) setAt({ x: row.right - 2, y: row.top - 4, flipX: row.left + 2 });
  }, []);
  return (
    <span ref={anchor} className="ctx-sub-anchor" onClick={(e) => e.stopPropagation()}>
      {at && <MenuList items={items} x={at.x} y={at.y} flipX={at.flipX} depth={depth} onClose={onClose} onBack={onBack} />}
    </span>
  );
}

function firstEnabled(items: PopupItem[], from: number, dir: 1 | -1): number {
  const n = items.length;
  for (let k = 0; k < n; k++) {
    const i = (((from + k * dir) % n) + n) % n;
    if (!isOff(items[i])) return i;
  }
  return -1;
}
