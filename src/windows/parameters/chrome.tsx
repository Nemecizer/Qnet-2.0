// The parameter panels' shared chrome (0.90.34 DSSheet: DSSheetHeader, DSSheetFooter,
// DSSheetMissingTarget, and the forms' "Save changes…?" confirmation dialog).
import { useEffect, useRef, type ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { Icon } from "../../components/Icon";
import { InlineMessage } from "../../panes/inspector/fields";
import { panelWords as w } from "../../panes/inspector/words";

export function PanelHeader({ glyph, title, subtitle, a11y, children }: { glyph: ReactNode; title: string; subtitle: string; a11y?: string; children?: ReactNode }) {
  return (
    <header className="panel-header">
      <div className="panel-header-main" role="group" aria-label={a11y} style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", minWidth: 0 }}>
        <span className="panel-glyph">{glyph}</span>
        <div style={{ minWidth: 0 }}>
          <h1 className="panel-title">{title}</h1>
          <p className="panel-subtitle">{subtitle}</p>
        </div>
      </div>
      {children}
    </header>
  );
}

/** Cancel (Escape) and the confirm button (Return); the first problem, or the leading note, on the left. */
export function PanelFooter({ problem, leading, confirmTitle, canConfirm, cancelHelp, confirmHelp, blockedHelp, onCancel, onConfirm }: { problem: string | null; leading?: ReactNode; confirmTitle: string; canConfirm: boolean; cancelHelp: string; confirmHelp: string; blockedHelp: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <footer className="panel-footer">
      <div className="panel-footer-note">{problem ? <div aria-label={w.cannotContinue(problem)}><InlineMessage message={problem} severity="error" lines={2} /></div> : leading}</div>
      <button type="button" className="btn" title={cancelHelp} onClick={onCancel}>
        {w.cancel}
      </button>
      <button type="button" className="btn primary" disabled={!canConfirm} title={canConfirm ? confirmHelp : blockedHelp} onClick={onConfirm}>
        {confirmTitle}
      </button>
    </footer>
  );
}

export function MissingTarget({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div
      className="panel-form"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="panel-missing">
        <Icon icon={CircleHelp} size={32} />
        <p>{message}</p>
        <button type="button" className="btn" autoFocus onClick={onClose}>
          {w.close}
        </button>
      </div>
    </div>
  );
}

/** The three-way "Save changes to … before closing / switching?" prompt. */
export function UnsavedPrompt({ title, message, canSave, onSave, onDiscard, onCancel }: { title: string; message: string; canSave: boolean; onSave: () => void; onDiscard: () => void; onCancel: () => void }) {
  const first = useRef<HTMLButtonElement | null>(null);
  useEffect(() => first.current?.focus(), []);
  return (
    <div
      className="panel-prompt"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <div className="panel-prompt-box" role="alertdialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <p>{message}</p>
        <div className="panel-prompt-actions">
          <button ref={canSave ? first : undefined} type="button" className="btn primary" disabled={!canSave} onClick={onSave}>
            {w.save}
          </button>
          <button type="button" className="btn danger-text" onClick={onDiscard}>
            {w.dontSave}
          </button>
          <button ref={canSave ? undefined : first} type="button" className="btn" onClick={onCancel}>
            {w.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 0.90.34 waited for the standard motion (0.25 s, none under Reduce Motion) plus 0.05 s before opening the link panel. */
export function settleDelay(): number {
  const reduce = document.documentElement.dataset.motion === "reduce" || (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  return (reduce ? 0 : 250) + 50;
}
