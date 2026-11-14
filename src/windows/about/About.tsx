// Qnet ▸ About Qnet (0.90.34 AboutQnetWindow.swift; ledger section 14.5, MENU-001, KEY-031,
// SET-199): one small fixed-size window, 400 × 392, with the icon, the name, the version and when
// the build was made, what Qnet does, the copyright line, and links to Release Notes and the
// Acknowledgements list; Close answers Return. Only its position is remembered (under 0.90.34's
// `WindowFrame.QnetAboutWindow`): its size is fixed, so a saved size is never applied.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AuxWindow, raiseAuxWindow } from "../../lib/auxWindow";
import { api, inTauri } from "../../lib/api";
import { setStateValues } from "../../lib/kv";
import type { AboutInfo, AppInfo } from "../../lib/types";
import { versionLabel } from "../../lib/vocabulary";
import { auxTauriWindow, isDegenerate, restorableFrame } from "../../workspace/layout/frames";
import { formatRect } from "../../workspace/tabs/frame";
import { openReleaseNotes } from "../releasenotes";
import icon from "../../../src-tauri/icons/128x128@2x.png";
import list from "./acknowledgements.json";
import { aboutWords as w, dateText, timeText } from "./words";
import "./about.css";

export const ABOUT_WINDOW = "about";
export const ABOUT_FRAME_KEY = "WindowFrame.QnetAboutWindow";
/** `DS.Layout.Window.aboutPanel`. */
export const ABOUT_SIZE: [number, number] = [400, 392];

export interface Acknowledgement {
  name: string;
  detail: string;
  licence: string;
}
export const ACKNOWLEDGEMENTS: Acknowledgement[] = list;

let state = { open: false, acknowledgements: false, token: 0 };
const listeners = new Set<() => void>();
const set = (next: typeof state) => {
  state = next;
  listeners.forEach((l) => l());
};

/** Opens About, or brings it forward; `acknowledgements` opens its Acknowledgements list too. */
export function openAbout(opts: { acknowledgements?: boolean } = {}) {
  const wasOpen = state.open;
  set({ open: true, acknowledgements: !!opts.acknowledgements, token: state.token + 1 });
  if (wasOpen) raiseAuxWindow(ABOUT_WINDOW);
}

export function closeAbout() {
  if (state.open) set({ ...state, open: false, acknowledgements: false });
}

export const aboutOpen = () => state.open;

/** For tests. */
export function resetAboutWindow() {
  set({ open: false, acknowledgements: false, token: 0 });
}

/** The copyright year: the build's, else 2026 (`copyrightYear`). */
export const copyrightYear = (builtMs: number | null) => (builtMs ? String(new Date(builtMs).getFullYear()) : "2026");

/** The window's contents. */
export function AboutView({ onClose, showAcknowledgements = false, token = 0 }: { onClose: () => void; showAcknowledgements?: boolean; token?: number }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [about, setAbout] = useState<AboutInfo | null>(null);
  const [ack, setAck] = useState(showAcknowledgements);
  useEffect(() => setAck(showAcknowledgements), [showAcknowledgements, token]);
  useEffect(() => {
    let alive = true;
    api.appInfo().then((i) => alive && setInfo(i), () => {});
    api.aboutInfo().then((a) => alive && setAbout(a), () => {});
    return () => {
      alive = false;
    };
  }, []);
  const built = about?.builtMs ? new Date(about.builtMs) : null;
  return (
    <div
      className="about"
      onKeyDown={(e) => {
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
        // Escape closes the Acknowledgements list first, as a popover's does.
        if (e.key === "Escape" && ack) {
          e.preventDefault();
          e.stopPropagation();
          setAck(false);
          return;
        }
        // Return is the default button, Close (KEY-031), unless another button or a link has the keyboard.
        if (e.key === "Enter" && !(e.target as HTMLElement).closest("button, a")) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="about-panel">
        <img className="about-icon" src={icon} alt={w.iconLabel} width={96} height={96} />
        <h1 className="about-name">{w.appName}</h1>
        <p className="about-version">{w.version(info ? versionLabel(info.version, info.instance, info.buildTag) : "…")}</p>
        {built && <p className="about-built">{w.built(dateText(built), timeText(built))}</p>}
        <p className="about-description">{w.description}</p>
        <p className="about-copyright">{w.copyright(copyrightYear(about?.builtMs ?? null))}</p>
        <span className="about-spring" />
        <div className="about-links">
          <button type="button" className="about-link" title={w.releaseNotesHelp} onClick={() => openReleaseNotes()}>
            {w.releaseNotes}
          </button>
          <button type="button" className="about-link" title={w.acknowledgementsHelp} aria-expanded={ack} aria-haspopup="dialog" onClick={() => setAck((v) => !v)}>
            {w.acknowledgements}
          </button>
          <span className="spacer" />
          <button type="button" className="btn primary" title={w.closeHelp} aria-label={w.closeLabel} autoFocus onClick={onClose}>
            {w.close}
          </button>
        </div>
      </div>
      {ack && (
        <div className="about-ack" role="dialog" aria-label={w.acknowledgements}>
          <h2>{w.acknowledgements}</h2>
          <p className="about-ack-lead">{w.acknowledgementsLead}</p>
          <dl className="about-ack-list">
            {ACKNOWLEDGEMENTS.map((a) => (
              <div key={a.name} className="about-ack-row" title={a.licence}>
                <dt>{a.name}</dt>
                <dd>{a.detail}</dd>
              </div>
            ))}
          </dl>
          <div className="about-ack-foot">
            <button type="button" className="btn" onClick={() => setAck(false)}>
              {w.done}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Puts the window where it was left and keeps saving where it is moved to. The size is locked at
 * 400 × 392 (minimum and maximum), so only the saved frame's origin is ever applied (ABOUT-007).
 */
async function trackPosition(alive: () => boolean, onStop: (stop: () => void) => void) {
  if (!inTauri) return;
  const win = await auxTauriWindow(ABOUT_WINDOW);
  if (!win || !alive()) return;
  try {
    const { LogicalPosition, LogicalSize } = await import("@tauri-apps/api/window");
    await win.setMaxSize(new LogicalSize(ABOUT_SIZE[0], ABOUT_SIZE[1]));
    const saved = await restorableFrame(ABOUT_FRAME_KEY);
    if (saved) await win.setPosition(new LogicalPosition(saved.x, saved.y));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unlisten = await win.onMoved(() => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const [pos, size, scale] = await Promise.all([win.outerPosition(), win.outerSize(), win.scaleFactor()]);
          const f = { x: pos.x / scale, y: pos.y / scale, w: size.width / scale, h: size.height / scale };
          if (alive() && !isDegenerate(f)) await setStateValues({ [ABOUT_FRAME_KEY]: formatRect(f) });
        } catch {
          // The window went away.
        }
      }, 250);
    });
    onStop(() => {
      clearTimeout(timer);
      unlisten();
    });
  } catch {
    // No permission, or the window closed: it stays where it opened.
  }
}

/** Mounts the About window while it is open. */
export function AboutHost() {
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
  const stop = useRef<(() => void) | null>(null);
  const current = useRef<Window | null>(null);
  if (!s.open) return null;
  const close = () => {
    stop.current?.();
    stop.current = null;
    current.current = null;
    closeAbout();
  };
  return (
    <AuxWindow
      name={ABOUT_WINDOW}
      title={w.windowTitle}
      size={ABOUT_SIZE}
      minSize={ABOUT_SIZE}
      onOpen={(win) => {
        current.current = win;
        void trackPosition(
          () => current.current === win,
          (fn) => {
            if (current.current === win) stop.current = fn;
            else fn();
          },
        );
      }}
      onClose={close}
    >
      <AboutView onClose={close} showAcknowledgements={s.acknowledgements} token={s.token} />
    </AuxWindow>
  );
}
