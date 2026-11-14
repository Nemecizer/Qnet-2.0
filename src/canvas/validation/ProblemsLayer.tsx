// Problems where they are (new in 2.1, ROADMAP C4): a badge on every node that has one, a marked
// link for a link's, and on hover, focus or a click a popover with one sentence and the fixes.
//
// HTML over the canvas's SVG, a sibling of the drawing surface: so the badges are real buttons
// (in the tab order, with names), a press on one never starts a canvas gesture, and nothing here
// can reach an exported diagram, which renders SceneLayers alone. The badges sit in a container
// translated by the pan at pan-relative positions, each memoised on plain values, so a pan
// re-renders none and a drag only the dragged node's.
//
// Placement, against what else sits round a node: the ρ badge hangs off the top-right corner, the
// results overlay's value badge is centred 10 pt above the body and its ring runs 7.5 pt outside;
// the problem badge takes the top-left corner, under the value badge's bottom edge, and steps
// further left when a small zoom brings the ρ badge across.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "../../editor/editor";
import type { BnetDocument } from "../../lib/bnet";
import { outlineSize } from "../geometry/outline";
import { lineWidth, type CanvasScene } from "../geometry/scene";
import { rhoBadgeText } from "../layers/labels";
import { linkStrokeD } from "../layers/shapes";
import { BADGE_SIZE, textWidth } from "../layers/text";
import { useValidationCommands } from "./commands";
import type { Fix } from "./fixes";
import { SeverityGlyph } from "./Glyph";
import { targetKey, targetOf, worst, type Diagnostic, type DiagnosticSeverity } from "./model";
import { ExplainButton } from "../../panes/ai/explain/open";
import { FixButtons, ProblemText } from "./ProblemItems";
import { checkNetwork, setOpenProblem, useDiagnostics, useOpenProblem, useProblemsShown, useValidation } from "./store";
import { validationWords as w } from "./words";
import "./validation.css";

/** The badge's box, and how far its centre sits outside the body's top-left corner. */
export const PROBLEM_BADGE = 20;
const OUTSIDE = 2;
/** Room kept between the problem badge and the ρ badge. */
const RHO_GAP = 3;
/** The ρ badge's geometry (NodeView.tsx `RhoBadge`): 8 pt off the corner, 5 pt padding each side. */
const RHO_OFFSET = 8;
const RHO_PAD = 5;
/** A link's badge sits this far above its probability chip. */
const LINK_LIFT = 16;
/** The popover's size, for choosing the side it opens on. */
const POP_WIDTH = 280;
const POP_HEIGHT = 190;
/** How long the pointer may be off a badge and its popover before the popover closes. */
export const HOVER_CLOSE_MS = 220;

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Where a node's badge is centred, relative to the node's display centre. */
export function badgeOffset(kind: BnetDocument["nodes"][number]["kind"], scale: number, rho: number | undefined): { dx: number; dy: number } {
  const os = outlineSize(kind);
  const w2 = (os.width * scale) / 2;
  const h2 = (os.height * scale) / 2;
  let dx = -w2 - OUTSIDE;
  if (rho !== undefined) {
    const rhoLeft = w2 + RHO_OFFSET - (textWidth(rhoBadgeText(rho), BADGE_SIZE, 600) + 2 * RHO_PAD);
    dx = Math.min(dx, rhoLeft - RHO_GAP - PROBLEM_BADGE / 2);
  }
  return { dx, dy: -h2 + OUTSIDE };
}

interface MarkProps {
  tkey: string;
  /** Pan-relative display position of the badge's centre. */
  x: number;
  y: number;
  severity: DiagnosticSeverity;
  name: string | null;
  list: readonly Diagnostic[];
  expanded: boolean;
  flipX: boolean;
  flipY: boolean;
  /** The room the popover has on the side it opens; 0 while closed. */
  room: number;
  editor: Editor;
  onEnter: (key: string) => void;
  onLeave: (key: string) => void;
  onToggle: (key: string) => void;
  onClose: (key: string, refocus: boolean) => void;
  onFix: (fix: Fix) => void;
}

function MarkImpl({ tkey, x, y, severity, name, list, expanded, flipX, flipY, room, editor, onEnter, onLeave, onToggle, onClose, onFix }: MarkProps) {
  const popId = `problem-pop-${tkey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  return (
    <span
      className="canvas-problem"
      data-problem={tkey}
      data-severity={severity}
      style={{ left: x, top: y }}
      onPointerEnter={() => onEnter(tkey)}
      onPointerLeave={() => onLeave(tkey)}
      onFocus={() => onEnter(tkey)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onLeave(tkey);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && expanded) {
          e.preventDefault();
          e.stopPropagation();
          onClose(tkey, true);
        }
      }}
    >
      <button
        type="button"
        className="canvas-problem-badge"
        aria-label={w.badgeLabel(severity, w.sentence(list[0]), list.length - 1)}
        aria-expanded={expanded}
        aria-controls={expanded ? popId : undefined}
        onClick={() => onToggle(tkey)}
      >
        <SeverityGlyph severity={severity} />
      </button>
      {expanded && (
        <div id={popId} className="canvas-problem-pop canvas-appear" role="group" aria-label={name === null ? w.popoverLabelLink : w.popoverLabel(name)} data-flip-x={flipX || undefined} data-flip-y={flipY || undefined} style={{ maxHeight: Math.max(96, room) }}>
          {list.map((d, i) => (
            <div key={i} className="problem-item" data-severity={d.severity} data-code={d.code}>
              <p className="problem-text">
                <ProblemText d={d} />
              </p>
              <FixButtons d={d} editor={editor} onFix={onFix} inspector={i === list.length - 1} />
              {i === list.length - 1 ? <ExplainButton about="problem" detail={list.length === 1 ? w.sentence(d) : undefined} /> : null}
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

const Mark = memo(MarkImpl);

export interface ProblemsLayerProps {
  editor: Editor;
  /** The frame's scene, as the drawing has it. */
  scene: CanvasScene;
  document: BnetDocument | undefined;
  /** Station id → ρ, for stepping clear of the ρ badge. */
  utilisation?: Readonly<Record<string, number>>;
}

export function ProblemsLayer({ editor, scene, document, utilisation }: ProblemsLayerProps) {
  const tabId = editor.tabId;
  useValidation(tabId, document);
  useValidationCommands();
  const shown = useProblemsShown();
  const diagnostics = useDiagnostics(tabId);
  const open = useOpenProblem(tabId);
  const [hover, setHover] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One mark per node or link, with everything wrong there; a link a node's problem names is
  // marked without a badge of its own.
  const { groups, marked } = useMemo(() => {
    const groups = new Map<string, { kind: "node" | "link"; id: string; list: Diagnostic[] }>();
    const marked = new Map<string, DiagnosticSeverity>();
    for (const d of diagnostics ?? []) {
      const t = targetOf(d);
      if (t) {
        const key = targetKey(t);
        const g = groups.get(key);
        if (g) g.list.push(d);
        else groups.set(key, { kind: t.kind, id: t.id, list: [d] });
      }
      // The list is sorted worst first, so the first severity a link gets is its worst.
      for (const id of d.linkIds) if (!marked.has(id)) marked.set(id, d.severity);
    }
    return { groups, marked };
  }, [diagnostics]);

  const cancelClose = () => {
    if (closing.current) clearTimeout(closing.current);
    closing.current = null;
  };
  useEffect(() => cancelClose, []);
  const onEnter = useCallback((key: string) => {
    cancelClose();
    setHover(key);
  }, []);
  const onLeave = useCallback((key: string) => {
    cancelClose();
    closing.current = setTimeout(() => setHover((h) => (h === key ? null : h)), HOVER_CLOSE_MS);
  }, []);
  const focusCanvas = useCallback(() => {
    root.current?.closest(".canvas-view")?.querySelector<HTMLElement>(".canvas-surface")?.focus({ preventScroll: true });
  }, []);
  const onClose = useCallback(
    (key: string, refocus: boolean) => {
      cancelClose();
      setHover(null);
      setOpenProblem(tabId, null);
      if (refocus) root.current?.querySelector<HTMLElement>(`[data-problem="${key}"] > button`)?.focus({ preventScroll: true });
    },
    [tabId],
  );
  const openKey = open?.target ?? null;
  const openRef = useRef(openKey);
  openRef.current = openKey;
  const onToggle = useCallback(
    (key: string) => {
      if (openRef.current === key) onClose(key, false);
      else setOpenProblem(tabId, key);
    },
    [tabId, onClose],
  );
  const onFix = useCallback(
    (fix: Fix) => {
      fix.run();
      cancelClose();
      setHover(null);
      setOpenProblem(tabId, null);
      // The badge is about to go: the keyboard returns to the canvas, and the check runs at once.
      focusCanvas();
      void checkNetwork(tabId);
    },
    [tabId, focusCanvas],
  );

  // Next Problem and the list move the keyboard to the badge they opened.
  const nonce = open?.focus ? open.nonce : 0;
  useEffect(() => {
    if (!nonce || !openRef.current) return;
    root.current?.querySelector<HTMLElement>(`[data-problem="${openRef.current}"] > button`)?.focus({ preventScroll: true });
  }, [nonce, shown]);

  if (!shown || !diagnostics || (!groups.size && !marked.size)) return null;

  const t = scene.transform;
  const { width, height } = t.viewportSize;
  const linkIndex = marked.size || [...groups.values()].some((g) => g.kind === "link") ? new Map(scene.links.map((l) => [l.id, l])) : null;
  const marks: React.ReactNode[] = [];
  for (const [key, g] of groups) {
    let at: { x: number; y: number } | null = null;
    let name: string | null = null;
    if (g.kind === "node") {
      const node = scene.nodeIndex.get(g.id);
      const c = scene.displayCentres.get(g.id);
      if (!node || !c) continue;
      const o = badgeOffset(node.kind, t.scale, utilisation?.[node.id]);
      at = { x: c.x + o.dx, y: c.y + o.dy };
      name = node.name;
    } else {
      // A link the class filter hides has no mark either.
      const l = linkIndex?.get(g.id);
      if (!l) continue;
      at = { x: l.geometry.labelAnchor.x, y: l.geometry.labelAnchor.y - LINK_LIFT };
    }
    const expanded = openKey === key || hover === key;
    // Below the badge when it fits there, else on whichever side has more room.
    const below = height - at.y - 24;
    const above = at.y - 24;
    const flipY = expanded && below < POP_HEIGHT && above > below;
    marks.push(
      <Mark
        key={key}
        tkey={key}
        x={r2(at.x - t.pan.width)}
        y={r2(at.y - t.pan.height)}
        severity={worst(g.list)}
        name={name}
        list={g.list}
        expanded={expanded}
        flipX={expanded && at.x > width - POP_WIDTH - 8 && at.x > POP_WIDTH}
        flipY={flipY}
        room={expanded ? Math.round(flipY ? above : below) : 0}
        editor={editor}
        onEnter={onEnter}
        onLeave={onLeave}
        onToggle={onToggle}
        onClose={onClose}
        onFix={onFix}
      />,
    );
  }
  const halo = lineWidth(t.scale) + 7;
  return (
    <div ref={root} className="canvas-problems" role="group" aria-label={w.layerLabel} data-count={marks.length}>
      {marked.size > 0 && (
        <svg className="canvas-problems-links" width={width} height={height} aria-hidden="true" focusable="false">
          {[...marked].map(([id, severity]) => {
            const l = linkIndex?.get(id);
            return l ? <path key={id} className="canvas-problem-link" data-problem-link={id} data-severity={severity} d={linkStrokeD(l.geometry)} strokeWidth={r2(halo)} /> : null;
          })}
        </svg>
      )}
      <div className="canvas-problems-pan" style={{ transform: `translate(${r2(t.pan.width)}px, ${r2(t.pan.height)}px)` }}>
        {marks}
      </div>
    </div>
  );
}
