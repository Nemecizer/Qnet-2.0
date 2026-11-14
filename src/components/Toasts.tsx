import { useEffect, useState } from "react";
import { CircleCheck, Info, LoaderCircle, OctagonAlert, TriangleAlert, X } from "lucide-react";
import { dismissToast, pauseToast, resumeToast, useToasts, visibleToasts, type Toast, type ToastKind } from "../lib/toasts";
import { shellWords } from "./words";
import "./shell.css";

const ICON: Record<ToastKind, typeof Info> = { success: CircleCheck, error: OctagonAlert, warning: TriangleAlert, info: Info, progress: LoaderCircle };
const w = shellWords.toasts;

/**
 * Toasts at the bottom right of the work area, above the status bar (and the dock when it
 * shows), the newest at the bottom. Rendered inside the desktop so they never cover the
 * top bar or a window's toolbar. Three at most; "N more" opens the rest.
 */
export function Toasts() {
  const toasts = useToasts();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (toasts.length <= 3) setExpanded(false);
  }, [toasts.length]);
  if (!toasts.length) return null;
  const { shown, more } = visibleToasts(toasts, expanded);
  return (
    <div className={`toasts${expanded ? " expanded" : ""}`} role="region" aria-label={w.region} data-shell-overlay>
      {more > 0 && (
        <button type="button" className="toast-more" onClick={() => setExpanded(true)} aria-label={w.moreLabel(more)}>
          {w.more(more)}
        </button>
      )}
      {expanded && toasts.length > 3 && (
        <button type="button" className="toast-more" onClick={() => setExpanded(false)}>{w.fewer}</button>
      )}
      {shown.map((t) => <ToastCard key={t.id} t={t} />)}
    </div>
  );
}

function ToastCard({ t }: { t: Toast }) {
  const Icon = ICON[t.kind];
  const run = async (fn: () => unknown) => {
    dismissToast(t.id);
    try {
      await fn();
    } catch (e) {
      console.error(e);
    }
  };
  return (
    <div
      className={`toast toast-${t.kind}`}
      // A group, not a live region: `toast()` already speaks the words through the shared
      // announcer (src/lib/announce.ts), and a second live region here read every toast twice.
      role="group"
      aria-label={w.card(w.kind[t.kind], t.title)}
      onPointerEnter={() => pauseToast(t.id)}
      onPointerLeave={() => resumeToast(t.id)}
      onFocus={() => pauseToast(t.id)}
      onBlur={() => resumeToast(t.id)}
    >
      <Icon className={`toast-icon${t.kind === "progress" ? " spin" : ""}`} size={16} aria-hidden />
      <div className="toast-main">
        <div className="toast-title">{t.title}</div>
        {t.body && <div className="toast-body">{t.body}</div>}
        {t.kind === "progress" && (
          <div
            className={`toast-bar${t.progress == null ? " indeterminate" : ""}`}
            role="progressbar"
            aria-label={t.title}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={t.progress == null ? undefined : Math.round(t.progress * 100)}
          >
            <i style={t.progress == null ? undefined : { width: `${Math.max(0, Math.min(1, t.progress)) * 100}%` }} />
          </div>
        )}
        {(t.undo || t.actions?.length) && (
          <div className="toast-actions">
            {t.undo && <button className="toast-btn strong" onClick={() => run(t.undo!)}>{w.undo}</button>}
            {t.actions?.map((a) => <button key={a.label} className="toast-btn" onClick={() => run(a.run)}>{a.label}</button>)}
          </div>
        )}
      </div>
      <button className="toast-close" aria-label={w.dismiss} title={w.dismiss} onClick={() => dismissToast(t.id)}>
        <X size={12} aria-hidden />
      </button>
    </div>
  );
}
