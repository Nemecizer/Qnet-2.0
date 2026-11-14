// The status bar's Problems count and the list it opens (new in 2.1, ROADMAP C4). The count is a
// button: errors and warnings each with their mark, or "No problems". The list, above the bar,
// has one row per problem; choosing a row selects and reveals its node or link and opens its
// explanation on the canvas, and each row carries the same fix buttons as the canvas popover, so
// the list works on its own when problems are hidden on the canvas.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "../../editor/editor";
import { shortcutFor } from "../../lib/menu";
import { goToProblem } from "./commands";
import { SeverityGlyph } from "./Glyph";
import { countProblems, targetOf, type Diagnostic } from "./model";
import { FixButtons, ProblemText } from "./ProblemItems";
import { checkNetwork, setProblemsListOpen, setProblemsShown, useDiagnostics, useProblemsListOpen, useProblemsShown } from "./store";
import { validationWords as w } from "./words";
import "./validation.css";

/** Nothing until the network has been checked once: the bar never claims "No problems" unasked. */
export function ProblemsSegment({ editor }: { editor: Editor }) {
  const diagnostics = useDiagnostics(editor.tabId);
  const open = useProblemsListOpen();
  const button = useRef<HTMLButtonElement>(null);
  if (!diagnostics) return null;
  const c = countProblems(diagnostics);
  const clear = c.errors + c.warnings === 0;
  return (
    <>
      <span className="canvas-sb-div" aria-hidden="true" />
      <button
        ref={button}
        type="button"
        className="canvas-sb-problems"
        data-clear={clear || undefined}
        title={w.countHelp(shortcutFor("view:next-problem") ?? "Next Problem", shortcutFor("view:previous-problem") ?? "Previous Problem")}
        aria-label={w.countSpoken(c)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setProblemsListOpen(!open)}
      >
        {clear ? (
          <span>{w.none}</span>
        ) : (
          <>
            {c.errors > 0 && (
              <span className="canvas-sb-problem-count" data-severity="error">
                <SeverityGlyph severity="error" size={12} />
                {c.errors}
              </span>
            )}
            {c.warnings > 0 && (
              <span className="canvas-sb-problem-count" data-severity="warning">
                <SeverityGlyph severity="warning" size={12} />
                {c.warnings}
              </span>
            )}
          </>
        )}
      </button>
      {open && <ProblemsList editor={editor} diagnostics={diagnostics} anchor={button} />}
    </>
  );
}

function ProblemsList({ editor, diagnostics, anchor }: { editor: Editor; diagnostics: readonly Diagnostic[]; anchor: React.RefObject<HTMLButtonElement | null> }) {
  const shown = useProblemsShown();
  const panel = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; bottom: number } | null>(null);
  const doc = anchor.current?.ownerDocument ?? document;
  const close = (refocus: boolean) => {
    setProblemsListOpen(false);
    if (refocus) anchor.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    const el = anchor.current;
    const view = el?.ownerDocument.defaultView;
    if (!el || !view) return;
    const r = el.getBoundingClientRect();
    setAt({ left: Math.max(8, Math.min(r.left, view.innerWidth - 408)), bottom: Math.max(8, view.innerHeight - r.top + 4) });
  }, [anchor]);

  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (panel.current?.contains(target) || anchor.current?.contains(target)) return;
      setProblemsListOpen(false);
    };
    doc.addEventListener("pointerdown", onDown, true);
    return () => doc.removeEventListener("pointerdown", onDown, true);
  }, [doc, anchor]);

  const c = countProblems(diagnostics);
  return createPortal(
    <div
      ref={panel}
      className="problems-list canvas-appear"
      role="dialog"
      aria-label={w.listTitle}
      tabIndex={-1}
      style={at ? { left: at.left, bottom: at.bottom } : { left: 8, bottom: 32 }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close(true);
        }
      }}
    >
      <div className="problems-list-head">
        <h2 className="problems-list-title">{w.listTitle}</h2>
        <span className="problems-list-count">{w.count(c)}</span>
      </div>
      {diagnostics.length === 0 ? (
        <p className="problems-list-empty">{w.listEmpty}</p>
      ) : (
        <ul className="problems-list-body">
          {diagnostics.map((d, i) => {
            const target = targetOf(d);
            return (
              <li key={i} className="problem-item" data-severity={d.severity} data-code={d.code}>
                {target ? (
                  <button
                    type="button"
                    className="problems-row"
                    aria-label={w.goTo(`${w.severity[d.severity]}. ${w.sentence(d)}`)}
                    onClick={() => {
                      // The list goes first, so the keyboard can land on the problem's badge.
                      setProblemsListOpen(false);
                      if (!goToProblem(editor, d, shown)) return;
                      if (!shown) anchor.current?.closest(".canvas-pane")?.querySelector<HTMLElement>(".canvas-surface")?.focus({ preventScroll: true });
                    }}
                  >
                    <ProblemText d={d} />
                  </button>
                ) : (
                  <p className="problems-row">
                    <ProblemText d={d} />
                  </p>
                )}
                <FixButtons
                  d={d}
                  editor={editor}
                  onFix={(f) => {
                    if (f.id === "inspector") setProblemsListOpen(false);
                    f.run();
                    void checkNetwork(editor.tabId);
                  }}
                />
              </li>
            );
          })}
        </ul>
      )}
      {!shown && (
        <div className="problems-list-foot">
          <span>{w.listHidden}</span>
          <button type="button" className="btn" onClick={() => setProblemsShown(true)}>
            {w.showOnCanvas}
          </button>
        </div>
      )}
    </div>,
    doc.body,
  );
}
