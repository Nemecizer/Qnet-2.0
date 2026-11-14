// A DSSheet body for a movable panel (0.90.34 `DSPanelWindow` hosting a `DSSheet`): the header
// (title and subtitle), the grouped form, and the footer with the first blocking problem, an
// optional summary line, Cancel (Escape) and the confirm button (Return). The files area's sheets
// draw the same chrome as an in-page card (src/workspace/files/Sheet.tsx); this fills a window.
// Used by the diagram export options and the archetype gallery.
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import "../../workspace/files/files.css";
import "./panels.css";

export interface PanelFooter {
  problem?: string | null;
  summary?: ReactNode;
  cancelTitle: string;
  confirmTitle: string;
  canConfirm: boolean;
  cancelHelp: string;
  confirmHelp: string;
  blockedHelp?: string;
  onCancel: () => void;
  onConfirm: () => unknown;
}

export function PanelForm({ id, title, subtitle, footer, wide, children }: { id: string; title: string; subtitle: string; footer: PanelFooter; wide?: boolean; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const latest = useRef(footer);
  latest.current = footer;
  const confirm = async () => {
    const f = latest.current;
    if (busy || !f.canConfirm) return;
    setBusy(true);
    try {
      await f.onConfirm();
    } finally {
      setBusy(false);
    }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (!busy) latest.current.onCancel();
    } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      void confirm();
    }
  };
  const problem = footer.problem && footer.problem.length ? footer.problem : null;
  return (
    <div className={`qn-panel-form${wide ? " wide" : ""}`} role="dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-subtitle`} data-panel={id} onKeyDown={onKeyDown}>
      <header className="qn-sheet-header">
        <div className="qn-sheet-heading">
          <h2 id={`${id}-title`} className="qn-sheet-title">{title}</h2>
          <p id={`${id}-subtitle`} className="qn-sheet-subtitle">{subtitle}</p>
        </div>
      </header>
      <div className="qn-panel-content">{children}</div>
      <footer className="qn-panel-footer">
        {problem && (
          <span className="qn-sheet-problem" role="status">
            {problem}
          </span>
        )}
        {footer.summary && <span className="qn-panel-summary">{footer.summary}</span>}
        <span className="spacer" />
        <button type="button" className="btn" title={footer.cancelHelp} aria-keyshortcuts="Escape" disabled={busy} onClick={() => footer.onCancel()}>
          {footer.cancelTitle}
        </button>
        <button type="button" className="btn primary" title={footer.canConfirm ? footer.confirmHelp : (footer.blockedHelp ?? footer.confirmHelp)} aria-keyshortcuts="Enter" disabled={!footer.canConfirm || busy} onClick={() => void confirm()}>
          {footer.confirmTitle}
        </button>
      </footer>
    </div>
  );
}

/** DSSegmentedPicker: one choice of a few, as a row of buttons. */
export function Segmented<T extends string | number>({ label, help, value, options, title, onChange }: { label: string; help: string; value: T; options: readonly T[]; title: (v: T) => string; onChange: (v: T) => void }) {
  return (
    <div className="qn-segmented" role="radiogroup" aria-label={label} title={help}>
      {options.map((o) => (
        <button key={String(o)} type="button" role="radio" aria-checked={o === value} data-on={o === value || undefined} onClick={() => onChange(o)}>
          {title(o)}
        </button>
      ))}
    </div>
  );
}
