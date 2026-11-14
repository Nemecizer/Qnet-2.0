// The Canvas Outline (new in 2.1, ledger WF-604…607; docs/ACCESSIBILITY.md): the network as a
// list, for anyone who cannot or would rather not work on a diagram. Two tables, nodes and links,
// each row one button that selects it on the canvas; under them, what can be done to the
// selection (edit, move, link, delete, a problem's fixes) and four buttons that add a node.
// Everything goes through the editor's own mutations: one undo step each, the same Status lines,
// the same rules for a link as the Link tool's.
//
// A dialog that is not modal, over the top-left of the canvas: the canvas stays live beside it, so
// a sighted helper sees each selection as it is made. Escape closes it and gives the keyboard back
// to the canvas. Each table is one Tab stop (↑ ↓ Home End move between its rows).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Icon } from "../../components/Icon";
import { KIND_NAMES, type Editor } from "../../editor";
import { useEditorView } from "../../editor";
import { announce } from "../../lib/announce";
import type { BnetDocument, BnetNode } from "../../lib/bnet";
import { runCommand } from "../../lib/commands";
import { displayFixed } from "../../editor/numbers";
import { toDisplay } from "../geometry/transform";
import { keyboardSpot } from "../interaction/controller";
import type { CanvasResults } from "../overlay/ResultsLayer";
import { FixButtons, ProblemText } from "../validation/ProblemItems";
import { checkNetwork, useDiagnostics } from "../validation/store";
import { linkFacts, linksInOutlineOrder, nodeFacts, problemsSummary, resultsCaption, type OutlineContext } from "./describe";
import { setOutlineOpen, useOutlineOpen } from "./store";
import { outlineWords as w } from "./words";
import "./outline.css";

const KINDS = ["source", "buffer", "station", "sink"] as const;
const NONE: readonly never[] = [];

/** Pans, without zooming, so the node is in view. */
function reveal(editor: Editor, node: BnetNode) {
  const t = editor.canvasTransform;
  const { width, height } = t.viewportSize;
  if (!(width > 160 && height > 160)) return;
  const p = toDisplay(t, { x: node.position[0], y: node.position[1] });
  if (p.x >= 80 && p.x <= width - 80 && p.y >= 80 && p.y <= height - 80) return;
  editor.pan({ width: width / 2 - p.x, height: height / 2 - p.y });
}

/** ↑ ↓ Home End between the row buttons of one table. */
function onRowKey(e: KeyboardEvent<HTMLElement>) {
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-outline-row]")];
  const i = rows.indexOf(e.target as HTMLElement);
  if (i < 0) return;
  const next = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : null;
  if (next === null) return;
  e.preventDefault();
  rows[Math.max(0, Math.min(rows.length - 1, next))].focus();
}

export interface CanvasOutlineProps {
  editor: Editor;
  document: BnetDocument | undefined;
  results: CanvasResults | null;
  utilisation?: Readonly<Record<string, number>>;
  /** The canvas surface: where the outline sits and where the keyboard returns. */
  surface: React.RefObject<HTMLDivElement | null>;
}

/** Mounted by the canvas; renders the outline while it is open. */
export function CanvasOutline(props: CanvasOutlineProps) {
  const open = useOutlineOpen();
  return open ? <Outline {...props} /> : null;
}

function Outline({ editor, document: bnet, results, utilisation, surface }: CanvasOutlineProps) {
  const view = useEditorView(editor);
  const diagnostics = useDiagnostics(editor.tabId) ?? NONE;
  const panel = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const [linkTarget, setLinkTarget] = useState("");
  const doc = surface.current?.ownerDocument ?? document;

  useLayoutEffect(() => {
    const el = surface.current;
    const win = el?.ownerDocument.defaultView;
    if (!el || !win) return;
    const place = () => {
      const r = el.getBoundingClientRect();
      setAt({ left: Math.max(8, r.left + 8), top: Math.max(8, r.top + 8), maxHeight: Math.max(240, win.innerHeight - Math.max(8, r.top + 8) - 16) });
    };
    place();
    win.addEventListener("resize", place);
    return () => win.removeEventListener("resize", place);
  }, [surface]);

  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
  }, []);

  const close = () => {
    setOutlineOpen(false);
    surface.current?.focus({ preventScroll: true });
  };

  const ctx: OutlineContext = useMemo(() => ({ editor, results, diagnostics, utilisation }), [editor, results, diagnostics, utilisation]);
  // `bnet` is the reason to recompute: the editor reads the same arrays.
  const nodes = useMemo(() => editor.nodesInReadingOrder.map((n) => nodeFacts(ctx, n)), [ctx, editor, bnet]);
  const links = useMemo(() => linksInOutlineOrder(editor).map((l) => linkFacts(ctx, l)), [ctx, editor, bnet]);

  const selectedNodeID = view.selectedNodeID ?? (view.selectedNodeIDs.size === 1 ? [...view.selectedNodeIDs][0] : null);
  const selectedNode = nodes.find((f) => f.node.id === selectedNodeID) ?? null;
  const selectedLink = links.find((f) => f.link.id === view.selectedLinkID) ?? null;
  const targets = selectedNode ? nodes.filter((f) => f.node.kind !== "source") : [];
  const target = targets.some((f) => f.node.id === linkTarget) ? linkTarget : "";

  const selectNode = (node: BnetNode) => {
    editor.setView({ selectedNodeID: node.id, selectedNodeIDs: new Set([node.id]), selectedLinkID: null });
    reveal(editor, node);
  };
  const add = (kind: (typeof KINDS)[number]) => {
    const created = editor.addNode(kind, keyboardSpot(editor, selectedNodeID));
    reveal(editor, created);
    announce(w.added(KIND_NAMES[kind], created.name));
  };
  const move = (dx: number, dy: number) => {
    const step = editor.nudgeStep(false);
    editor.nudgeSelection({ width: dx * step, height: dy * step });
    editor.endNudgeRun();
    const n = editor.node(selectedNodeID);
    if (n) {
      reveal(editor, n);
      announce(w.moved(n.name, displayFixed(n.position[0], 0), displayFixed(n.position[1], 0)));
    }
  };
  /** The Link tool's own two clicks, so its rules and its Status lines are the outline's too. */
  const addLink = () => {
    if (!selectedNodeID || !target) return;
    const tool = editor.view.tool;
    const before = editor.links.length;
    editor.setTool("addLink");
    editor.handleNodeTap(selectedNodeID);
    if (editor.view.pendingLinkStartID === selectedNodeID) editor.handleNodeTap(target);
    editor.setTool(tool);
    editor.setView({ pendingLinkStartID: null });
    const made = editor.links.length > before ? editor.links[editor.links.length - 1] : null;
    if (made) {
      editor.setView({ selectedNodeID: null, selectedNodeIDs: new Set(), selectedLinkID: made.id });
      announce(linkFacts(ctx, made).spoken);
    } else {
      // Refused: the Status pane has the reason, and so does the screen reader.
      const last = panel.current?.ownerDocument.querySelector<HTMLElement>('[data-pane="status"] [role="option"]:last-child');
      announce(last?.textContent?.trim() || w.linkNone, "assertive");
    }
  };

  const caption = resultsCaption(results);
  const selectionProblems = selectedNode?.problems ?? selectedLink?.problems ?? NONE;

  return createPortal(
    <div
      ref={panel}
      className="canvas-outline canvas-appear"
      role="dialog"
      aria-labelledby="canvas-outline-title"
      tabIndex={-1}
      data-canvas-outline
      style={at ?? { left: 8, top: 8, maxHeight: 480 }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          e.stopPropagation();
          close();
        } else if (e.key === "Tab" && !e.altKey && !e.metaKey && !e.ctrlKey) {
          // The panel is the last thing in the document: Tab goes round inside it, Escape leaves.
          const stops = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"]), select:not([disabled])')];
          if (!stops.length) return;
          const active = e.currentTarget.ownerDocument.activeElement;
          const edge = e.shiftKey ? stops[0] : stops[stops.length - 1];
          if (active === edge || active === e.currentTarget) {
            e.preventDefault();
            (e.shiftKey ? stops[stops.length - 1] : stops[0]).focus();
          }
        }
      }}
    >
      <header className="canvas-outline-head">
        <h2 id="canvas-outline-title">{w.title}</h2>
        <span className="canvas-outline-summary">{w.summary(nodes.length, links.length)}</span>
        <button type="button" className="icon-btn canvas-outline-close" aria-label={w.close} title={w.closeHelp} onClick={close}>
          <Icon icon={X} size={14} aria-hidden />
        </button>
      </header>

      <div className="canvas-outline-body">
        <div className="canvas-outline-add" role="group" aria-label={w.addLabel}>
          <span className="canvas-outline-add-label" aria-hidden="true">{w.addLabel}</span>
          {KINDS.map((k) => (
            <button key={k} type="button" className="btn" data-outline-add={k} title={w.addHelp} aria-label={w.add(KIND_NAMES[k])} onClick={() => add(k)}>
              {KIND_NAMES[k]}
            </button>
          ))}
        </div>

        {nodes.length === 0 ? (
          <p className="canvas-outline-empty">{w.empty}</p>
        ) : (
          <>
            <h3 id="canvas-outline-nodes">{w.nodesHeading}</h3>
            <table className="canvas-outline-table" aria-labelledby="canvas-outline-nodes" aria-describedby="canvas-outline-nodes-caption" data-outline-nodes>
              <caption id="canvas-outline-nodes-caption" className="sr-only">{`${w.nodesCaption(caption)} ${w.rowsHelp}.`}</caption>
              <thead>
                <tr>
                  <th scope="col">{w.col.node}</th>
                  <th scope="col">{w.col.kind}</th>
                  <th scope="col">{w.col.parameters}</th>
                  <th scope="col">{w.col.result}</th>
                  <th scope="col">{w.col.problems}</th>
                </tr>
              </thead>
              <tbody onKeyDown={onRowKey}>
                {nodes.map((f, i) => {
                  const on = f.node.id === selectedNodeID;
                  return (
                    <tr key={f.node.id} data-selected={on || undefined} data-node-row={f.node.id}>
                      <th scope="row">
                        <button
                          type="button"
                          className="canvas-outline-row"
                          data-outline-row
                          tabIndex={on || (!selectedNode && i === 0) ? 0 : -1}
                          aria-pressed={on}
                          aria-label={w.select(f.spoken)}
                          onClick={() => selectNode(f.node)}
                        >
                          {f.node.name}
                        </button>
                      </th>
                      <td>{f.kind}</td>
                      <td>{f.parameters || w.noResult}</td>
                      <td className="canvas-outline-num">{f.result ?? <span aria-label={w.noResultSpoken}>{w.noResult}</span>}</td>
                      <td data-problems={f.problems.length || undefined}>{problemsSummary(f.problems)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {caption && <p className="canvas-outline-caption">{caption}</p>}

            <h3 id="canvas-outline-links">{w.linksHeading}</h3>
            {links.length === 0 ? (
              <p className="canvas-outline-empty">{w.noLinks}</p>
            ) : (
              <table className="canvas-outline-table" aria-labelledby="canvas-outline-links" aria-describedby="canvas-outline-links-caption" data-outline-links>
                <caption id="canvas-outline-links-caption" className="sr-only">{`${w.linksCaption} ${w.rowsHelp}.`}</caption>
                <thead>
                  <tr>
                    <th scope="col">{w.col.link}</th>
                    <th scope="col">{w.col.cls}</th>
                    <th scope="col">{w.col.probability}</th>
                    <th scope="col">{w.col.problems}</th>
                  </tr>
                </thead>
                <tbody onKeyDown={onRowKey}>
                  {links.map((f, i) => {
                    const on = f.link.id === view.selectedLinkID;
                    return (
                      <tr key={f.link.id} data-selected={on || undefined} data-link-row={f.link.id}>
                        <th scope="row">
                          <button
                            type="button"
                            className="canvas-outline-row"
                            data-outline-row
                            tabIndex={on || (!selectedLink && i === 0) ? 0 : -1}
                            aria-pressed={on}
                            aria-label={w.select(f.spoken)}
                            onClick={() => editor.setView({ selectedNodeID: null, selectedNodeIDs: new Set(), selectedLinkID: f.link.id })}
                          >
                            {f.label}
                          </button>
                        </th>
                        <td>{f.cls}</td>
                        <td className="canvas-outline-num">{f.probability}</td>
                        <td data-problems={f.problems.length || undefined}>{problemsSummary(f.problems)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </>
        )}

        <section className="canvas-outline-selection" aria-labelledby="canvas-outline-selection">
          <h3 id="canvas-outline-selection">{w.selectedHeading}</h3>
          {!selectedNode && !selectedLink ? (
            <p className="canvas-outline-empty">{w.nothingSelected}</p>
          ) : (
            <>
              <p className="canvas-outline-selected" data-outline-selected>
                <strong>{selectedNode ? w.selectedNode(selectedNode.kind, selectedNode.node.name) : w.selectedLink(selectedLink!.label)}</strong>
              </p>
              <div className="canvas-outline-actions">
                <button type="button" className="btn" data-outline-action="edit" title={w.editHelp} onClick={() => editor.openParameterEditorForSelection()}>
                  {w.edit}
                </button>
                <button type="button" className="btn" data-outline-action="inspector" title={w.inspectorHelp} onClick={() => void runCommand("window:focus-inspector")}>
                  {w.inspector}
                </button>
                <button type="button" className="btn" data-outline-action="delete" title={w.removeHelp} onClick={() => editor.deleteSelection()}>
                  {w.remove}
                </button>
              </div>
              {selectedNode && (
                <>
                  <div className="canvas-outline-actions" role="group" aria-label={w.moveLabel}>
                    <button type="button" className="btn" data-outline-move="left" onClick={() => move(-1, 0)}>{w.move.left}</button>
                    <button type="button" className="btn" data-outline-move="right" onClick={() => move(1, 0)}>{w.move.right}</button>
                    <button type="button" className="btn" data-outline-move="up" onClick={() => move(0, -1)}>{w.move.up}</button>
                    <button type="button" className="btn" data-outline-move="down" onClick={() => move(0, 1)}>{w.move.down}</button>
                  </div>
                  {selectedNode.node.kind !== "sink" && (
                    <div className="canvas-outline-actions">
                      <label className="canvas-outline-linkto" title={w.linkToHelp}>
                        <span>{w.linkTo}</span>
                        <select value={target} data-outline-link-target onChange={(e) => setLinkTarget(e.target.value)}>
                          <option value="">{w.linkNone}</option>
                          {targets.map((f) => (
                            <option key={f.node.id} value={f.node.id}>{`${f.node.name} (${f.kind})`}</option>
                          ))}
                        </select>
                      </label>
                      <button type="button" className="btn" data-outline-action="link" disabled={!target} onClick={addLink}>
                        {w.addLink}
                      </button>
                    </div>
                  )}
                </>
              )}
              {selectionProblems.length > 0 && (
                <div className="canvas-outline-problems" role="group" aria-label={w.problemsOf}>
                  {selectionProblems.map((d, i) => (
                    <div key={i} className="problem-item" data-severity={d.severity} data-code={d.code}>
                      <p className="problem-text">
                        <ProblemText d={d} />
                      </p>
                      <FixButtons
                        d={d}
                        editor={editor}
                        inspector={false}
                        onFix={(f) => {
                          f.run();
                          void checkNetwork(editor.tabId);
                        }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>,
    doc.body,
  );
}
