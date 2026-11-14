// The status bar under the canvas (0.90.34 ContentView.swift `CanvasStatusBar`; canvas.md §16;
// ledger CAN-159…CAN-162, CAN-203): tool · zoom % · selection summary (or "Selecting N nodes" in
// accent while a marquee is live) · primitive counts (full words, else kind symbols when narrow) ·
// snap state · buffer regime · pan offset when non-zero · [run segment, P6]. 11-pt type with
// tabular digits so numbers don't jitter. The canvas pane puts it in its bar, before the pane's
// window control.
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Icon } from "../components/Icon";
import { TOOL_NAMES, type Editor } from "../editor/editor";
import { useEditorView } from "../editor";
import type { NodeKind } from "../lib/bnet";
import { shortcutFor } from "../lib/menu";
import { useWorkspace } from "../workspace/store";
import { KIND_ICONS, SYMBOLS, TOOL_ICONS } from "./layers/icons";
import { marqueeSelects } from "./geometry/outline";
import { canvasWords as w } from "./words";
import { ProblemsSegment } from "./validation/ProblemsSegment";
import { LiveReadout } from "../live/LiveReadout";
import { AnimateButton } from "../animate/AnimateButton";
import "./canvas.css";

type CountStyle = "words" | "symbols";

export interface CanvasStatusBarProps {
  editor: Editor;
  /** The run segment (P6): progress, the last run's summary, or Idle. */
  run?: ReactNode;
  /** Forces one form of the primitive counts (tests); otherwise words when they fit, symbols when not. */
  countStyle?: CountStyle;
}

const key = (id: string, fallback: string) => shortcutFor(id) ?? fallback;

function Segment({ help, label, className, children }: { help: string; label?: string; className?: string; children: ReactNode }) {
  return (
    <span className={`canvas-sb-seg${className ? ` ${className}` : ""}`} title={help} aria-label={label} role={label ? "group" : undefined}>
      {children}
    </span>
  );
}

const Divider = () => <span className="canvas-sb-div" aria-hidden="true" />;

export function CanvasStatusBar({ editor, run, countStyle }: CanvasStatusBarProps) {
  const view = useEditorView(editor);
  const doc = useWorkspace((ws) => ws.tabs.find((t) => t.id === editor.tabId)?.document);
  const nodes = doc?.nodes ?? [];
  const links = doc?.links ?? [];
  const infinite = doc?.infiniteBuffers ?? false;

  const band = view.multiSelectRect;
  const marqueeCount = band ? nodes.reduce((c, n) => (marqueeSelects(n, band) ? c + 1 : c), 0) : null;
  const selected = new Set(view.selectedNodeIDs);
  if (view.selectedNodeID) selected.add(view.selectedNodeID);
  const hasLink = view.selectedLinkID !== null;
  const summary = w.selectionSummary(selected.size, hasLink);

  const count = (k: NodeKind) => nodes.reduce((c, n) => (n.kind === k ? c + 1 : c), 0);
  const counts = w.primitives.map(([id, singular, plural]) => ({ id, singular, plural, value: id === "link" ? links.length : count(id) }));

  const pan = view.canvasPanOffset;
  const px = Math.sign(pan.width) * Math.round(Math.abs(pan.width));
  const py = Math.sign(pan.height) * Math.round(Math.abs(pan.height));
  const panned = pan.width !== 0 || pan.height !== 0;
  const snapOn = view.snapToGrid && !view.snapSuspended;

  const ToolGlyph = TOOL_ICONS[view.tool];
  const bar = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLSpanElement>(null);
  const spacer = useRef<HTMLSpanElement>(null);
  const style = useCountStyle(bar, list, spacer, countStyle, counts.map((c) => c.value).join() + view.tool + summary + String(panned));

  return (
    <div ref={bar} className="canvas-sb" role="group" aria-label={w.statusBar}>
      <Segment help={w.toolHelp}>
        <Icon icon={ToolGlyph} size={12} className="canvas-sb-glyph" />
        <span className="canvas-sb-strong">{TOOL_NAMES[view.tool]}</span>
      </Segment>
      <Divider />
      <Segment help={w.zoomHelp(key("view:zoom-in", "⌘="), key("view:zoom-out", "⌘−"), key("view:actual-size", "⌘0"), key("view:zoom-to-fit", "⇧⌘0"), key("view:zoom-to-selection", "⌥⇧⌘0"))}>
        <span className="canvas-sb-zoom">{w.percent(view.canvasScale)}</span>
      </Segment>
      <Divider />
      {marqueeCount !== null ? (
        <Segment help={w.selectingHelp} className="canvas-sb-selecting">
          <span>{w.selecting(marqueeCount)}</span>
        </Segment>
      ) : (
        <Segment help={w.selectionHelp} label={summary}>
          <span className={selected.size || hasLink ? undefined : "canvas-sb-quiet"}>{summary}</span>
        </Segment>
      )}
      {/* Live results for the one selected station (src/live/), beside the selection it describes. */}
      <LiveReadout tabId={editor.tabId} stationId={selected.size === 1 && !hasLink ? [...selected][0] : null} />
      <Divider />
      <Segment help={w.primitivesHelp} className="canvas-sb-counts">
        <Counts counts={counts} style={style} listRef={list} />
      </Segment>
      <Divider />
      <Segment help={view.snapSuspended ? w.snapHelpBarSuspended : w.snapHelpBar(key("view:snap-to-grid", "⌥⌘G"))}>
        <Icon
          icon={SYMBOLS.snapToGrid}
          size={12}
          className={snapOn ? "canvas-sb-snap-on" : "canvas-sb-snap-off"}
          aria-label={view.snapSuspended ? w.snapSpoken.suspended : view.snapToGrid ? w.snapSpoken.on : w.snapSpoken.off}
        />
        {view.snapSuspended && <span className="canvas-sb-quiet">{w.freePlacement}</span>}
      </Segment>
      <Divider />
      <Segment help={infinite ? w.infiniteBuffersHelp : w.finiteBuffersHelp}>
        <span>{infinite ? w.infiniteBuffers : w.finiteBuffers}</span>
      </Segment>
      {panned && (
        <>
          <Divider />
          <Segment help={w.panHelp(key("view:actual-size", "⌘0"))} label={w.panSpoken(px, py)}>
            <Icon icon={SYMBOLS.pan} size={12} className="canvas-sb-glyph" />
            <span className="canvas-sb-quiet">{w.pan(px, py)}</span>
          </Segment>
        </>
      )}
      <ProblemsSegment editor={editor} />
      <AnimateButton tabId={editor.tabId} />
      <span ref={spacer} className="canvas-sb-spacer" />
      {run !== undefined && (
        <span className="canvas-sb-run" data-slot="run">
          {run}
        </span>
      )}
    </div>
  );
}

interface Count {
  id: string;
  singular: string;
  plural: string;
  value: number;
}

/**
 * `ViewThatFits`: the words form while the bar has room for it, the symbols form otherwise. The
 * bar's spacer is the room left over; the words come back once it could hold the difference.
 */
function useCountStyle(bar: RefObject<HTMLDivElement | null>, list: RefObject<HTMLSpanElement | null>, spacer: RefObject<HTMLSpanElement | null>, force: CountStyle | undefined, deps: string): CountStyle {
  const [style, setStyle] = useState<CountStyle>("words");
  const wordsWidth = useRef(0);
  useLayoutEffect(() => {
    if (force) return;
    const el = bar.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const check = () => {
      const l = list.current;
      if (!l) return;
      if (style === "words") {
        wordsWidth.current = l.scrollWidth;
        if (el.scrollWidth > el.clientWidth + 0.5) setStyle("symbols");
      } else {
        // The room to spare is the spacer beyond its own minimum width, which the words form must
        // leave too: counting that minimum as free made the two forms swap without end at some widths.
        const sp = spacer.current;
        const free = sp ? sp.offsetWidth - (parseFloat(sp.ownerDocument.defaultView?.getComputedStyle(sp).minWidth ?? "0") || 0) : 0;
        if (wordsWidth.current && free + l.scrollWidth >= wordsWidth.current + 1) setStyle("words");
      }
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [force, style, deps]);
  return force ?? style;
}

const COUNT_ICON = (id: string) => (id === "link" ? SYMBOLS.link : KIND_ICONS[id as NodeKind]);

function Counts({ counts, style, listRef }: { counts: Count[]; style: CountStyle; listRef: RefObject<HTMLSpanElement | null> }) {
  return (
    <span ref={listRef} className={`canvas-sb-countlist canvas-sb-${style}`} data-style={style}>
      {counts.map((c) => {
        const spoken = w.countSpoken(c.value, c.singular, c.plural);
        return (
          <span key={c.id} className="canvas-sb-count" title={spoken} aria-label={spoken} role="img">
            {style === "words" ? (
              <>
                <span className="canvas-sb-num" aria-hidden="true">
                  {c.value}
                </span>
                <span className="canvas-sb-quiet" aria-hidden="true">
                  {c.value === 1 ? c.singular : c.plural}
                </span>
              </>
            ) : (
              <>
                <Icon icon={COUNT_ICON(c.id)} size={12} className="canvas-sb-glyph" />
                <span className="canvas-sb-num canvas-sb-num-lead" aria-hidden="true">
                  {c.value}
                </span>
              </>
            )}
          </span>
        );
      })}
    </span>
  );
}
