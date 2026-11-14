// One split view (ContentView's VSplitView / HSplitView with its SplitViewConfigurator, ledger
// WS-063…066): its panes in order, a thin divider between each two, dragged with pointer capture
// (or the arrow keys), each pane kept inside its min/max. Every pane but the flexible one is laid out
// at its saved size; the flexible one takes the slack. Sizes are saved under
// `SplitPane.<split>.<pane>` (and the legacy `SplitSizes.<split>` with the full pane set) when a
// drag ends.
import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { KvValues } from "../../lib/types";
import { commitOverrides, liveState, registerSplit, setOverrides, splitHandle, useLiveVersion, type DragSession } from "./live";
import { basisOf, dragDivider, paneKey, savePatch, SPLITS, type Extent, type SplitName } from "./sizes";
import { paneWords } from "../panes/words";

export interface SplitItem {
  id: string;
  node: ReactNode;
}

export interface SplitProps {
  name: SplitName;
  items: SplitItem[];
  extents: Record<string, Extent>;
  /** Sizes another split should follow while this one changes (the coupled widths, WS-067). */
  follow?: (panes: string[], sizes: number[]) => Record<string, number> | null;
  /** Things drawn on a divider (the corner grips): divider index → node. */
  onDivider?: Record<number, ReactNode>;
  className?: string;
}

const KEY_STEP = 10;

export function Split({ name, items, extents, follow, onDivider, className }: SplitProps) {
  useLiveVersion();
  const def = SPLITS[name];
  const ref = useRef<HTMLDivElement>(null);
  const panes = items.map((i) => i.id);
  const flexible = panes.includes(def.flexible) ? def.flexible : panes[panes.length - 1];
  const state = liveState(panes.map((p) => paneKey(name, p)));
  const latest = useRef({ panes, follow, extents });
  latest.current = { panes, follow, extents };

  useEffect(() => {
    const along = (el: Element) => {
      const r = el.getBoundingClientRect();
      return def.vertical ? r.height : r.width;
    };
    const sizes = () => [...(ref.current?.children ?? [])].filter((c) => c.classList.contains("split-item")).map(along);
    return registerSplit(name, {
      panes: () => latest.current.panes,
      sizes,
      total: () => (ref.current ? along(ref.current) : 0),
      begin: (i: number): DragSession => {
        const { panes: ps, extents: ex } = latest.current;
        const start = sizes();
        const ext = ps.map((p) => ex[p] ?? { min: 0 });
        let now = start;
        return {
          move: (delta: number) => {
            now = dragDivider(start, ext, i, delta);
            const patch: Record<string, number> = {};
            ps.forEach((p, k) => {
              if (p !== def.flexible && (k === i || k === i + 1)) patch[paneKey(name, p)] = now[k];
            });
            Object.assign(patch, latest.current.follow?.(ps, now) ?? {});
            setOverrides(patch);
          },
          end: () => (savePatch(def, ps, now) as KvValues | null) ?? {},
        };
      },
    });
  }, [name]);

  const style = (id: string): CSSProperties => {
    const ext = extents[id] ?? { min: 0 };
    const minProp = def.vertical ? "minHeight" : "minWidth";
    const maxProp = def.vertical ? "maxHeight" : "maxWidth";
    if (items.length < 2 || id === flexible) return { flex: "1 1 0px", [minProp]: ext.min };
    const basis = basisOf(name, id, ext, state);
    return { flex: `0 1 ${basis}px`, [minProp]: ext.min, ...(ext.max ? { [maxProp]: ext.max } : {}) };
  };

  const out: ReactNode[] = [];
  items.forEach((item, i) => {
    if (i > 0) out.push(<Divider key={`d-${items[i - 1].id}-${item.id}`} split={name} index={i - 1} vertical={def.vertical}>{onDivider?.[i - 1]}</Divider>);
    out.push(
      <div key={item.id} className="split-item" data-split-pane={item.id} style={style(item.id)}>
        {item.node}
      </div>,
    );
  });
  return (
    <div ref={ref} className={`split ${def.vertical ? "split-v" : "split-h"}${className ? ` ${className}` : ""}`} data-split={name}>
      {out}
    </div>
  );
}

/** Runs one drag on `split`'s divider `index` and saves what it changed when it ends. */
export function startDrag(split: SplitName, index: number): { move: (d: number) => void; end: () => KvValues } | null {
  const h = splitHandle(split);
  if (!h || index < 0 || index >= h.panes().length - 1) return null;
  return h.begin(index);
}

function Divider({ split, index, vertical, children }: { split: SplitName; index: number; vertical: boolean; children?: ReactNode }) {
  const drag = useRef<{ session: DragSession; from: number } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    const session = startDrag(split, index);
    if (!session) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // jsdom, or a pointer that went away.
    }
    drag.current = { session, from: vertical ? e.clientY : e.clientX };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.session.move((vertical ? e.clientY : e.clientX) - d.from);
  };
  const finish = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    void commitOverrides(d.session.end());
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = vertical ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
    const k = keys.indexOf(e.key);
    if (k < 0) return;
    e.preventDefault();
    const session = startDrag(split, index);
    if (!session) return;
    session.move(k === 0 ? -KEY_STEP : KEY_STEP);
    void commitOverrides(session.end());
  };

  return (
    <div
      className={`split-divider ${vertical ? "split-divider-v" : "split-divider-h"}`}
      role="separator"
      aria-orientation={vertical ? "horizontal" : "vertical"}
      aria-label={paneWords.dividerLabel}
      tabIndex={-1}
      data-divider={`${split}:${index}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}
