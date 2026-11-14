// Shows queued alerts (src/lib/dialogs.ts) one at a time, modal over the window they belong to.
// Adapted from NetMon's ConfirmHost: the window behind goes inert, Tab stays inside, focus returns
// to where it was. Keys follow NSAlert: Return chooses the default button, Escape and ⌘. the
// Cancel button, and a button with a `key` answers to ⌘ and that letter (Don’t Save is ⌘D).
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Info, OctagonAlert, TriangleAlert } from "lucide-react";
import { useAlertQueue, type QueuedAlert } from "../lib/dialogs";
import "./shell.css";
import { shellWords } from "./words";

export function DialogHost() {
  const queue = useAlertQueue();
  // One per window: the first alert for each target document.
  const shown = new Map<Document, QueuedAlert>();
  for (const q of queue) {
    const doc = q.target && !q.target.defaultView?.closed ? q.target : document;
    if (!shown.has(doc)) shown.set(doc, q);
  }
  return <>{[...shown.entries()].map(([doc, q]) => createPortal(<Alert key={q.seq} req={q} doc={doc} />, doc.body))}</>;
}

const FOCUSABLE = "button:not(:disabled), input:not(:disabled), summary, [tabindex]:not([tabindex='-1'])";

function Alert({ req, doc }: { req: QueuedAlert; doc: Document }) {
  const ref = useRef<HTMLDivElement>(null);
  const [suppress, setSuppress] = useState(false);
  const titleId = `alert-title-${req.seq}`;
  const bodyId = `alert-body-${req.seq}`;
  const defaultButton = req.buttons.find((b) => b.role === "default") ?? req.buttons[0];
  const cancelButton = req.buttons.find((b) => b.role === "cancel");
  const choose = (id: string) => req.settle({ button: id, suppress });

  useLayoutEffect(() => {
    const app = doc.querySelector(".app, .aux-root");
    if (!app) return;
    app.setAttribute("inert", "");
    return () => app.removeAttribute("inert");
  }, [doc]);

  useEffect(() => {
    const opener = doc.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLButtonElement>(`[data-button="${CSS.escape(defaultButton.id)}"]`)?.focus({ preventScroll: true });
    return () => {
      doc.defaultView?.requestAnimationFrame(() => {
        if (opener?.isConnected && !opener.closest("[inert]")) opener.focus?.({ preventScroll: true });
      });
    };
  }, []);

  // Escape and ⌘. cancel even when focus has wandered off the alert.
  useEffect(() => {
    const win = doc.defaultView;
    if (!win) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || (e.key === "." && e.metaKey)) {
        if (!cancelButton) return;
        e.preventDefault();
        e.stopPropagation();
        choose(cancelButton.id);
        return;
      }
      if (e.metaKey && !e.altKey && !e.ctrlKey) {
        const b = req.buttons.find((x) => x.key && x.key.toLowerCase() === e.key.toLowerCase());
        if (b) {
          e.preventDefault();
          e.stopPropagation();
          choose(b.id);
        }
      }
    };
    win.addEventListener("keydown", onKey, true);
    return () => win.removeEventListener("keydown", onKey, true);
  }, [doc, suppress]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Tab") {
      const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (!items.length) return;
      const i = items.indexOf(doc.activeElement as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === items.length - 1 ? 0 : i + 1;
      e.preventDefault();
      items[next].focus();
    } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      choose(defaultButton.id);
    }
  };

  const style = req.style ?? "informational";
  const Icon = style === "critical" ? OctagonAlert : style === "warning" ? TriangleAlert : Info;
  const tone = style === "informational" ? "info" : "crit";
  // NSAlert's order, right to left: the first button rightmost. Shown left to right here.
  const ordered = [...req.buttons].reverse();

  return (
    <div className="sb-overlay" data-shell-overlay>
      <div ref={ref} className="sb-dialog modal" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={req.message ? bodyId : undefined} onKeyDown={onKeyDown}>
        <Icon className={`sb-dialog-icon ${tone}`} size={32} strokeWidth={1.75} aria-hidden />
        <div className="sb-dialog-main">
          <h2 id={titleId} className="sb-dialog-title">{req.title}</h2>
          {req.message && <div id={bodyId} className="sb-dialog-body">{req.message}</div>}
          {req.suppression && (
            <label className="sb-dialog-check">
              <input type="checkbox" checked={suppress} onChange={(e) => setSuppress(e.target.checked)} /> {req.suppression}
            </label>
          )}
          {req.details && (
            <details className="sb-dialog-details">
              <summary><ChevronRight size={12} className="sb-disclosure" aria-hidden />{shellWords.dialog.details}</summary>
              <div className="sb-dialog-details-box"><div className="sb-dialog-details-text">{req.details}</div></div>
            </details>
          )}
          <div className="sb-dialog-actions">
            <span className="spacer" />
            {ordered.map((b) => (
              <button
                key={b.id}
                type="button"
                data-button={b.id}
                className={`btn${b === defaultButton ? " primary" : ""}${b.role === "destructive" ? " danger-text" : ""}`}
                aria-keyshortcuts={b.key ? `Meta+${b.key.toUpperCase()}` : b.role === "cancel" ? "Escape" : undefined}
                onClick={() => choose(b.id)}
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
