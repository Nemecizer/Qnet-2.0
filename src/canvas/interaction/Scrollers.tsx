// The canvas's legacy scrollers (0.90.34 NetworkCanvasScrollContainer: an always-visible vertical
// NSScroller on the right, a horizontal one along the bottom and a corner filler, grey and inert
// while the content fits; canvas.md §14, ledger CAN-129, CAN-130). Each is a slot with a knob: a
// click in the slot pages towards it (max(0.05, knob × 0.9)), the knob drags, and the arrow keys
// step a line (0.05) when the scroller has focus. The value maps to a pan through the metrics'
// pan-independent box, so dragging the knob never fights the content.
import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { Editor } from "../../editor";
import { nextScrollValue, offsetX, offsetY, type ScrollMetrics, type ScrollerPart } from "./metrics";
import { interactionWords as w } from "./words";

/** NSScroller.scrollerWidth(for: .regular, scrollerStyle: .legacy). */
export const SCROLLER_WIDTH = 15;

export function Scroller({ axis, metrics, editor }: { axis: "h" | "v"; metrics: ScrollMetrics; editor: Editor }) {
  const slot = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startPx: number; startValue: number } | null>(null);
  const h = axis === "h";
  const enabled = h ? metrics.hEnabled : metrics.vEnabled;
  const knob = h ? metrics.hKnob : metrics.vKnob;
  const value = h ? metrics.hValue : metrics.vValue;

  const apply = (part: ScrollerPart, knobValue?: number) => {
    if (!enabled) return;
    const next = nextScrollValue(value, knob, part, knobValue);
    const pan = editor.view.canvasPanOffset;
    editor.setView({ canvasPanOffset: h ? { width: offsetX(metrics, next), height: pan.height } : { width: pan.width, height: offsetY(metrics, next) } });
  };

  const length = () => {
    const r = slot.current?.getBoundingClientRect();
    return r ? (h ? r.width : r.height) : 0;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!enabled || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const r = slot.current!.getBoundingClientRect();
    const pos = h ? e.clientX - r.left : e.clientY - r.top;
    const len = h ? r.width : r.height;
    const knobLen = len * knob;
    const knobStart = (len - knobLen) * value;
    if ((e.target as HTMLElement).dataset.knob !== undefined || (pos >= knobStart && pos <= knobStart + knobLen && len > 0)) {
      drag.current = { startPx: h ? e.clientX : e.clientY, startValue: value };
      e.currentTarget.setPointerCapture?.(e.pointerId);
      return;
    }
    apply(pos < knobStart ? "decrementPage" : "incrementPage");
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const travel = length() * (1 - knob);
    if (travel <= 0) return;
    apply("knob", d.startValue + ((h ? e.clientX : e.clientY) - d.startPx) / travel);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dec = h ? "ArrowLeft" : "ArrowUp";
    const inc = h ? "ArrowRight" : "ArrowDown";
    if (e.key === dec || e.key === inc) apply(e.key === dec ? "decrementLine" : "incrementLine");
    else if (e.key === "PageUp" || e.key === "PageDown") apply(e.key === "PageUp" ? "decrementPage" : "incrementPage");
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const knobPct = Math.max(0, Math.min(1, knob)) * 100;
  const startPct = (100 - knobPct) * value;
  return (
    <div
      ref={slot}
      className={`canvas-scroller canvas-scroller-${axis}`}
      role="scrollbar"
      aria-label={h ? w.hScroller : w.vScroller}
      aria-orientation={h ? "horizontal" : "vertical"}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      aria-disabled={!enabled || undefined}
      data-enabled={enabled || undefined}
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onKeyDown={onKeyDown}
    >
      {enabled && (
        <div
          className="canvas-scroller-knob"
          data-knob=""
          style={h ? { left: `${startPct}%`, width: `${knobPct}%` } : { top: `${startPct}%`, height: `${knobPct}%` }}
        />
      )}
    </div>
  );
}
