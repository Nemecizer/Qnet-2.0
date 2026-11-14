// A chart's place in the layout (new in 2.1): measures its own width with a ResizeObserver taken
// from the element's own window (a pane may be drawn through a portal into a detached window,
// whose observer and styles are not the main window's), reads the app's text scale there, and
// hands both to the chart, which is a pure drawing of (data, width, scale).
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface FrameSize {
  width: number;
  fontScale: number;
}

export function ChartFrame({ children, minWidth = 280, className }: { children: (size: FrameSize) => ReactNode; minWidth?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<FrameSize | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const win = el?.ownerDocument.defaultView;
    if (!el || !win) return;
    const measure = (w: number) => {
      const scale = Number.parseFloat(win.getComputedStyle(el).getPropertyValue("--text-scale"));
      const next = { width: Math.max(minWidth, Math.floor(w)), fontScale: Number.isFinite(scale) && scale > 0 ? scale : 1 };
      setSize((old) => (old && old.width === next.width && old.fontScale === next.fontScale ? old : next));
    };
    measure(el.clientWidth || minWidth);
    const Observer = (win as Window & typeof globalThis).ResizeObserver;
    if (!Observer) return;
    const ro = new Observer((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === "number") measure(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [minWidth]);
  return (
    <div ref={ref} className={className ? `chart-frame ${className}` : "chart-frame"}>
      {size ? children(size) : null}
    </div>
  );
}
