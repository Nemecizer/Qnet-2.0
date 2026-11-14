// A corner grip (CornerResizeOverlay.swift, ledger WS-069…071): a 24 × 24 pt hit area where a row's
// vertical divider meets the outer split's horizontal one. Hovering shows a crosshair and an L glyph
// for the quadrant under the pointer; dragging moves both dividers together, each within its panes'
// minimum sizes. It is drawn on the vertical divider, at the end that touches the outer divider.
import { useRef, useState, type PointerEvent } from "react";
import type { KvValues } from "../../lib/types";
import { commitOverrides } from "./live";
import { CORNER_HIT, lPath, quadrantOf, type Quadrant, type SplitName } from "./sizes";
import { startDrag } from "./Split";
import { paneWords } from "../panes/words";

export interface CornerGripProps {
  id: string;
  hSplit: SplitName;
  hIndex: number;
  outerIndex: number;
  /** "end": the divider's bottom end (top-row grips); "start": its top end (the bottom row's). */
  at: "start" | "end";
}

export function CornerGrip({ id, hSplit, hIndex, outerIndex, at }: CornerGripProps) {
  const [quadrant, setQuadrant] = useState<Quadrant | null>(null);
  const drag = useRef<{ x: number; y: number; h: ReturnType<typeof startDrag>; v: ReturnType<typeof startDrag> } | null>(null);

  const hover = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setQuadrant(quadrantOf(e.clientX - r.left - CORNER_HIT / 2, e.clientY - r.top - CORNER_HIT / 2));
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // jsdom.
    }
    drag.current = { x: e.clientX, y: e.clientY, h: startDrag(hSplit, hIndex), v: startDrag("OuterVSplit", outerIndex) };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return hover(e);
    d.h?.move(e.clientX - d.x);
    d.v?.move(e.clientY - d.y);
  };
  const finish = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    const patch: KvValues = { ...(d.h?.end() ?? {}), ...(d.v?.end() ?? {}) };
    void commitOverrides(patch);
  };

  return (
    <div
      className={`corner-grip corner-grip-${at}`}
      data-grip={id}
      title={paneWords.gripHelp}
      role="img"
      aria-label={paneWords.gripLabel}
      aria-description={paneWords.gripHint}
      onPointerEnter={hover}
      onPointerLeave={() => !drag.current && setQuadrant(null)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
    >
      {quadrant && (
        <svg className="corner-grip-l" width={CORNER_HIT} height={CORNER_HIT} viewBox={`0 0 ${CORNER_HIT} ${CORNER_HIT}`} aria-hidden>
          <path d={lPath(quadrant)} />
        </svg>
      )}
    </div>
  );
}
