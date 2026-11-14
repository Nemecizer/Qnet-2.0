// The files area's sheets in 0.90.34's DSSheet chrome: a header (title and one-line subtitle), a
// grouped form, and the footer with the first blocking problem, Cancel (Escape) and the confirm
// button (Return), ledger KEY-029, GEN-008. In-page, as a modal card over the main window like
// the alerts (src/components/DialogHost.tsx); the workspace counts as modal while one is up.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { useAlertQueue } from "../../lib/dialogs";
import { holdModal } from "../../lib/overlays";
import { fileWords as w } from "./words";
import { HelpButton } from "../../windows/help/HelpButton";
import "./files.css";

export interface SheetFooter {
  problem?: string | null;
  /** The Help article the sheet's "?" opens (0.90.34 `DSSheetFooter(helpTopic:)`, HELP-095). */
  helpTopic?: string;
  confirmTitle: string;
  canConfirm: boolean;
  cancelHelp: string;
  confirmHelp: string;
  blockedHelp: string;
  onCancel: () => void;
  /** May be async (a panel opens); the sheet ignores keys and buttons until it settles. */
  onConfirm: () => unknown;
}

const FOCUSABLE = "button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])";

export function Sheet({ id, title, subtitle, glossary, footer, children }: { id: string; title: string; subtitle: string; glossary?: { label: string; text: string }; footer: SheetFooter; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const alerts = useAlertQueue();
  const latest = useRef({ footer, busy, alerting: alerts.length > 0 });
  latest.current = { footer, busy, alerting: alerts.length > 0 };

  useLayoutEffect(() => holdModal(), []);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input, select, button")?.focus({ preventScroll: true });
    return () => {
      if (opener?.isConnected) opener.focus?.({ preventScroll: true });
    };
  }, []);

  const confirm = async () => {
    const { footer: f, busy: b } = latest.current;
    if (b || !f.canConfirm) return;
    setBusy(true);
    try {
      await f.onConfirm();
    } finally {
      setBusy(false);
    }
  };

  // Escape cancels and Return confirms wherever focus is in the window, unless an alert is up
  // (it answers its own keys) or the confirm action is still running.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { footer: f, busy: b, alerting } = latest.current;
      if (alerting || e.defaultPrevented) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (!b) f.onCancel();
      } else if (e.key === "Enter" && !e.metaKey && !e.altKey && !e.ctrlKey && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        e.stopPropagation();
        void confirm();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== "Tab") return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === items.length - 1 ? 0 : i + 1;
    e.preventDefault();
    items[next].focus();
  };

  const titleId = `${id}-title`;
  const problem = footer.problem && footer.problem.length ? footer.problem : null;
  return (
    <div className="sb-overlay qn-sheet-overlay" data-shell-overlay>
      <div ref={ref} className="qn-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={`${id}-subtitle`} data-sheet={id} onKeyDown={onKeyDown}>
        <header className="qn-sheet-header">
          <div className="qn-sheet-heading">
            <h2 id={titleId} className="qn-sheet-title">{title}</h2>
            <p id={`${id}-subtitle`} className="qn-sheet-subtitle">{subtitle}</p>
          </div>
          {glossary && <Glossary label={glossary.label} text={glossary.text} />}
        </header>
        <div className="qn-sheet-content">{children}</div>
        <footer className="qn-sheet-footer">
          {footer.helpTopic && <HelpButton topic={footer.helpTopic} />}
          {problem ? (
            <span className="qn-sheet-problem" role="status" aria-label={w.cannotContinue(problem)}>{problem}</span>
          ) : (
            <span />
          )}
          <span className="spacer" />
          <button type="button" className="btn" title={footer.cancelHelp} aria-keyshortcuts="Escape" disabled={busy} onClick={() => footer.onCancel()}>
            {w.cancel}
          </button>
          <button type="button" className="btn primary" title={footer.canConfirm ? footer.confirmHelp : footer.blockedHelp} aria-keyshortcuts="Enter" disabled={!footer.canConfirm || busy} onClick={() => void confirm()}>
            {footer.confirmTitle}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** A section of the grouped form: header, rows, and an optional footer note. */
export function Section({ title, footer, children }: { title: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <section className="qn-sheet-section" aria-label={title}>
      <h3 className="qn-sheet-section-title">{title}</h3>
      <div className="qn-sheet-rows">{children}</div>
      {footer && <p className="qn-sheet-section-footer">{footer}</p>}
    </section>
  );
}

/** One labelled row (SwiftUI `LabeledContent`). */
export function Row({ label, help, htmlFor, children }: { label: string; help?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="qn-sheet-row" title={help}>
      {htmlFor ? <label htmlFor={htmlFor} className="qn-sheet-label">{label}</label> : <span className="qn-sheet-label">{label}</span>}
      <span className="qn-sheet-value">{children}</span>
    </div>
  );
}

/** 0.90.34 `DSGlossaryButton`: a "?" that shows the term's explanation. */
export function Glossary({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="qn-glossary">
      <button type="button" className="icon-btn" aria-label={w.glossaryHelp(label)} title={w.glossaryHelp(label)} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <CircleHelp size={15} aria-hidden />
      </button>
      {open && (
        <span className="qn-glossary-pop" role="note">
          <strong>{label}</strong>
          <span>{text}</span>
        </span>
      )}
    </span>
  );
}
