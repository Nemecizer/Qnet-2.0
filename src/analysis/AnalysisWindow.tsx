// The auxiliary window the Method Chooser and the Network Model window live in (0.90.34
// `AuxiliaryWindow.make(id:title:contentSize:minSize:fullScreenAuxiliary:frameKey:)` with
// `DS.Layout.Window.auxWideContent` 1040 × 704 and `auxWideMin` 896 × 616): a window of its own,
// rendered from the main window's React tree (src/lib/auxWindow.tsx), its frame saved in
// state.json under 0.90.34's `WindowFrame.<frameKey>` and restored when it opens (SET-201,
// SET-202). Escape closes it, as every auxiliary window; Return runs `onDefault` (the footer's
// Close, 0.90.34's `.keyboardShortcut(.defaultAction)`) unless a control has the key.
import { useRef, type ReactNode } from "react";
import { AuxWindow } from "../lib/auxWindow";
import { getStateValue } from "../lib/kv";
import { auxTauriWindow, autosaveFrame } from "../workspace/layout/frames";
import { parseRect } from "../workspace/tabs/frame";
import "./analysis.css";

export const AUX_WIDE_SIZE: [number, number] = [1040, 704];
export const AUX_WIDE_MIN: [number, number] = [896, 616];

/** The size the window opens at: the saved frame's, else 0.90.34's wide auxiliary size. */
export function openingSize(frameKey: string): [number, number] {
  const f = parseRect(getStateValue<unknown>(frameKey, null));
  if (f && f.w > 200 && f.h > 200) return [Math.max(AUX_WIDE_MIN[0], Math.round(f.w)), Math.max(AUX_WIDE_MIN[1], Math.round(f.h))];
  return AUX_WIDE_SIZE;
}

export function AnalysisWindow({ name, title, frameKey, onClose, onDefault, children }: { name: string; title: string; frameKey: string; onClose: () => void; onDefault: () => void; children: ReactNode }) {
  const stopFrame = useRef<(() => void) | null>(null);
  const winRef = useRef<Window | null>(null);
  const close = () => {
    stopFrame.current?.();
    stopFrame.current = null;
    winRef.current = null;
    onClose();
  };
  return (
    <AuxWindow
      name={name}
      title={title}
      size={openingSize(frameKey)}
      minSize={AUX_WIDE_MIN}
      onOpen={(win) => {
        winRef.current = win;
        void auxTauriWindow(name).then((w) => {
          if (w && winRef.current === win) stopFrame.current = autosaveFrame(w, frameKey);
        });
      }}
      onClose={close}
    >
      <div
        className="an-window"
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
          const t = e.target as HTMLElement;
          if (["BUTTON", "INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.getAttribute("role") === "button") return;
          e.preventDefault();
          onDefault();
        }}
      >
        {children}
      </div>
    </AuxWindow>
  );
}

/** DSEmptyState: an icon, a title and a message, centred. */
export function EmptyState({ icon, title, message }: { icon?: ReactNode; title: string; message: string }) {
  return (
    <div className="an-empty" role="status">
      {icon}
      <strong>{title}</strong>
      <span>{message}</span>
    </div>
  );
}

export type Tint = "good" | "info" | "warn" | "accent" | "muted" | "plain";

/** DSBadge: plain, or tinted in its ink (a green tint is a dot and green text: healthy is quiet). */
export function Badge({ text, tint = "plain" }: { text: string; tint?: Tint }) {
  return (
    <span className="an-badge" data-tint={tint}>
      {tint === "good" ? <span className="an-badge-dot" aria-hidden /> : null}
      {text}
    </span>
  );
}
