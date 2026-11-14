// The canvas's floating chrome (0.90.34 NetworkCanvasOverlays.swift and the overlays in
// NetworkCanvasView.swift's body; docs/specs/canvas.md §16; ledger CAN-151…CAN-155, INV-025): the
// class legend bottom-left (only with more than one class), the zoom cluster bottom-right, and
// the empty-canvas hint centred while there are no nodes. The two corner panels never share a
// corner, so they cannot collide at any width.
//
// Mount it inside the canvas's positioned container, over the SVG. The layer itself lets every
// click through (pointer-events: none); only the panels and the hint's buttons take the pointer,
// so a click through the hint's text still reaches the canvas and places a node (INV-025).
import { useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import type { Editor } from "../../editor/editor";
import { useEditorView } from "../../editor";
import { runCommand } from "../../lib/commands";
import { shortcutFor } from "../../lib/menu";
import { useWorkspace } from "../../workspace/store";
import { PopupMenu, type PopupItem } from "../../workspace/panes/PopupMenu";
import { ZOOM_RANGE } from "../geometry/transform";
import { classColor, OPACITY } from "../layers/colors";
import { SYMBOLS } from "../layers/icons";
import { useCanvasColors } from "../layers/useCanvasColors";
import { canvasWords as w } from "../words";
import type { BnetDocument } from "../../lib/bnet";
import "../canvas.css";

/** `numberOfCustomerClasses`: sources, or the highest class any link names, plus one. */
export function classCount(doc: BnetDocument): number {
  const src = doc.nodes.filter((n) => n.kind === "source").length;
  let max = -1;
  for (const l of doc.links) max = Math.max(max, l.customerClass, l.toCustomerClass ?? -1);
  return Math.max(src, max + 1);
}

function useDocument(editor: Editor): BnetDocument | undefined {
  return useWorkspace((ws) => ws.tabs.find((t) => t.id === editor.tabId)?.document);
}

export function CanvasOverlays({ editor }: { editor: Editor }) {
  const doc = useDocument(editor);
  if (!doc) return null;
  return (
    <div className="canvas-overlays">
      {classCount(doc) > 1 && <ClassLegend editor={editor} classes={classCount(doc)} />}
      <ZoomCluster editor={editor} hasNodes={doc.nodes.length > 0} />
      {doc.nodes.length === 0 && <EmptyHint />}
    </div>
  );
}

// ── Class legend ────────────────────────────────────────────────────────────────────────────

/** One chip per class; clicking pins the class filter, clicking the active chip clears it. */
export function ClassLegend({ editor, classes }: { editor: Editor; classes: number }) {
  const view = useEditorView(editor);
  const colors = useCanvasColors();
  const filter = view.classFilter;
  return (
    <div className="canvas-panel canvas-legend canvas-appear" role="group" aria-label={w.legendLabel}>
      {Array.from({ length: classes }, (_, i) => {
        const active = filter === i;
        const dimmed = filter !== null && !active;
        return (
          <button
            key={i}
            type="button"
            className="canvas-class-chip"
            data-active={active || undefined}
            data-dimmed={dimmed || undefined}
            title={active ? w.legendHelpActive(i) : w.legendHelp(i)}
            aria-label={w.legendChipLabel(i)}
            aria-pressed={active}
            aria-description={active ? w.on : w.off}
            onClick={() => editor.setView({ classFilter: active ? null : i })}
          >
            <span className="canvas-class-swatch" style={{ background: classColor(colors, i), opacity: dimmed ? 0.35 : 1 }} aria-hidden="true" />
            {w.className(i)}
          </button>
        );
      })}
    </div>
  );
}

// ── Zoom cluster ────────────────────────────────────────────────────────────────────────────

const key = (id: string, fallback: string) => shortcutFor(id) ?? fallback;

/** Zoom out · percentage menu · zoom in · rule · Zoom to Fit · Snap to Grid. */
export function ZoomCluster({ editor, hasNodes }: { editor: Editor; hasNodes: boolean }) {
  const view = useEditorView(editor);
  const [menuAt, setMenuAt] = useState<DOMRect | null>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const scale = view.canvasScale;
  const percent = w.percent(scale);
  const fitKey = key("view:zoom-to-fit", "⇧⌘0");
  const selKey = key("view:zoom-to-selection", "⌥⇧⌘0");
  const actualKey = key("view:actual-size", "⌘0");

  const items: PopupItem[] = [
    ...[0.5, 1, 2].map((level) => ({ label: w.percent(level), run: () => editor.setZoom(level) })),
    "-",
    { label: w.zoomToFit, disabled: !hasNodes, run: () => editor.zoomToFit() },
    { label: w.zoomToSelection, disabled: !editor.canZoomToSelection, run: () => editor.zoomToFitSelection() },
  ];

  const snapHelp = view.snapSuspended ? w.snapHelpSuspended : view.snapToGrid ? w.snapHelpOn : w.snapHelpOff;

  return (
    <div className="canvas-panel canvas-zoom" role="group" aria-label={w.zoomControls}>
      <button type="button" className="icon-btn canvas-zoom-btn" aria-label={w.zoomOut} title={w.zoomOutHelp} disabled={scale <= ZOOM_RANGE.lower + 0.001} onClick={() => editor.zoomOut()}>
        <Icon icon={SYMBOLS.zoomOut} size={14} />
      </button>
      <button
        ref={menuButton}
        type="button"
        className="canvas-zoom-menu"
        aria-label={w.zoomLevel}
        aria-description={percent}
        aria-haspopup="menu"
        aria-expanded={!!menuAt}
        title={w.zoomLevelHelp(fitKey, selKey, actualKey)}
        onClick={() => setMenuAt(menuButton.current?.getBoundingClientRect() ?? new DOMRect())}
      >
        <span className="canvas-zoom-percent">{percent}</span>
        <span className="canvas-zoom-caret" aria-hidden="true">⌄</span>
      </button>
      <button type="button" className="icon-btn canvas-zoom-btn" aria-label={w.zoomIn} title={w.zoomInHelp} disabled={scale >= ZOOM_RANGE.upper - 0.001} onClick={() => editor.zoomIn()}>
        <Icon icon={SYMBOLS.zoomIn} size={14} />
      </button>
      <span className="canvas-rule" aria-hidden="true" />
      <button type="button" className="icon-btn canvas-zoom-btn" aria-label={w.zoomToFit} title={w.zoomToFitHelp(fitKey)} disabled={!hasNodes} onClick={() => editor.zoomToFit()}>
        <Icon icon={SYMBOLS.zoomToFit} size={14} />
      </button>
      <button
        type="button"
        className="icon-btn canvas-zoom-btn canvas-snap"
        aria-label={w.snapToGrid}
        aria-pressed={view.snapToGrid}
        data-on={view.snapToGrid || undefined}
        data-suspended={view.snapSuspended || undefined}
        title={snapHelp}
        style={{ opacity: view.snapSuspended ? OPACITY.disabled : 1 }}
        onClick={() => editor.setSnapToGrid(!view.snapToGrid)}
      >
        <Icon icon={SYMBOLS.snapToGrid} size={14} />
      </button>
      {menuAt && (
        <PopupMenu
          items={items}
          anchor={menuAt}
          label={w.zoomLevel}
          onClose={(chosen) => {
            setMenuAt(null);
            menuButton.current?.focus({ preventScroll: true });
            chosen?.();
          }}
        />
      )}
    </div>
  );
}

// ── Empty canvas ────────────────────────────────────────────────────────────────────────────

/**
 * "No Network Yet", with a way out of the blank page: the archetype first (prominent), the
 * examples second. Neither button has a key equivalent (File owns those keys). The icon and the
 * text opt out of hit-testing one by one, so a click through them reaches the canvas (INV-025).
 */
export function EmptyHint() {
  return (
    <div className="canvas-empty canvas-appear" role="group" aria-label={w.emptyTitle} aria-description={w.emptyMessage}>
      <span className="canvas-empty-icon" aria-hidden="true">
        <Icon icon={SYMBOLS.network} size={32} />
      </span>
      <h2 className="canvas-empty-title">{w.emptyTitle}</h2>
      <p className="canvas-empty-message">{w.emptyMessage}</p>
      <div className="canvas-empty-actions">
        <button type="button" className="btn primary" title={w.emptyArchetypeHelp} onClick={() => void runCommand("file:new-from-archetype")}>
          {w.emptyArchetype}
        </button>
        <button type="button" className="btn" title={w.emptyExampleHelp} onClick={() => void runCommand("file:open-example")}>
          {w.emptyExample}
        </button>
      </div>
    </div>
  );
}
