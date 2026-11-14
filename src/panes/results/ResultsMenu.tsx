// The Results header's Compare and Export menus (DSIconMenu): items, toggles with a check mark,
// plain text lines and separators, drawn in the pane's own document (docked or detached) with the
// shared context-menu styles; arrows move, Return chooses, Escape or a click outside closes.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDismiss } from "../status/popup";

export type ResultsMenuItem =
  | { kind?: "item"; label: string; disabled?: boolean; run: () => void }
  | { kind: "toggle"; label: string; checked: boolean; disabled?: boolean; run: () => void }
  | { kind: "text"; label: string }
  | "-";

const actionable = (it: ResultsMenuItem) => it !== "-" && it.kind !== "text" && !it.disabled;

export function ResultsMenu({ anchor, items, label, onClose }: { anchor: HTMLElement; items: ResultsMenuItem[]; label: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hi, setHi] = useState(-1);
  const [pos, setPos] = useState(() => {
    const r = anchor.getBoundingClientRect();
    return { left: r.left, top: r.bottom + 4 };
  });
  useDismiss(ref, anchor, onClose);
  useLayoutEffect(() => {
    const el = ref.current;
    const win = el?.ownerDocument.defaultView;
    if (!el || !win) return;
    const r = anchor.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(r.right - el.offsetWidth, win.innerWidth - el.offsetWidth - 8)), top: r.bottom + 4 });
  }, [anchor]);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const choose = (i: number) => {
    const it = items[i];
    if (!it || !actionable(it) || it === "-" || it.kind === "text") return;
    onClose();
    it.run();
  };
  const move = (d: 1 | -1) => {
    const n = items.length;
    for (let k = 1, i = hi; k <= n; k++) {
      i = (i + d + n) % n;
      if (actionable(items[i])) return setHi(i);
    }
  };
  return (
    <div
      ref={ref}
      className="ctx-menu results-menu"
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
      {items.map((it, i) => {
        if (it === "-") return <div key={i} className="ctx-sep" role="separator" />;
        if (it.kind === "text")
          return (
            <div key={i} className="ctx-item disabled" role="none">
              <span className="ctx-label">{it.label}</span>
            </div>
          );
        const toggle = it.kind === "toggle";
        return (
          <div
            key={i}
            role={toggle ? "menuitemcheckbox" : "menuitem"}
            aria-checked={toggle ? it.checked : undefined}
            aria-disabled={it.disabled || undefined}
            className={`ctx-item${i === hi ? " hi" : ""}${it.disabled ? " disabled" : ""}`}
            onMouseEnter={() => setHi(i)}
            onMouseLeave={() => setHi(-1)}
            onClick={() => choose(i)}
          >
            <span className="results-menu-check" aria-hidden>
              {toggle && it.checked ? "✓" : ""}
            </span>
            <span className="ctx-label">{it.label}</span>
          </div>
        );
      })}
    </div>
  );
}
