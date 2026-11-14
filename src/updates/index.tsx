// Automatic updates, built ready and switched off (A5, ledger UX-501…; docs/UPDATES.md).
//
// Qnet ▸ Check for Updates… and the launch check drive one UpdateFlow (./machine.ts) over Rust's
// updater (src-tauri/src/updates.rs); UpdateHost shows its sheet in the main window. A copy built
// without an update address (every build until the owner switches updates on) answers "This copy
// of Qnet does not check for updates." and contacts nothing.
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, CircleArrowDown, Info, OctagonAlert, RefreshCw } from "lucide-react";
import { api } from "../lib/api";
import { announce } from "../lib/announce";
import { runCommand, useCommands } from "../lib/commands";
import { getSetting, getStateValue, loadKv, setStateValues } from "../lib/kv";
import { holdModal } from "../lib/overlays";
import { getRunState, stopRun } from "../runs/state";
import { UpdateFlow, type UpdateEnv, type UpdatePhase, type UpdateSource } from "./machine";
import { ReleaseNotes } from "./notes";
import { updateWords as t } from "./words";
import "../components/shell.css";
import "./updates.css";

/** The setting (settings.json) and the two remembered values (state.json). */
export const AUTO_KEY = "updates.auto";
export const LAST_CHECK_KEY = "updates.lastCheck";
export const SKIPPED_KEY = "updates.skippedVersion";

/** How long a relaunch may take before Qnet is taken to be staying. */
const RELAUNCH_GRACE_MS = 4000;

const appSource: UpdateSource = {
  status: () => api.updateStatus(),
  check: () => api.updateCheck(),
  install: async (version, onProgress) => {
    await api.updateInstall(version, onProgress);
  },
  // Quit's own path, so its prompt and the session save run; Rust then restarts instead of exiting.
  relaunch: async () => {
    await api.updateRelaunch(true);
    try {
      await runCommand("app:quit");
      await new Promise((r) => setTimeout(r, RELAUNCH_GRACE_MS));
    } finally {
      await api.updateRelaunch(false).catch(() => {});
    }
    throw new Error("Qnet is still running.");
  },
};

const appEnv: UpdateEnv = {
  now: () => Date.now(),
  auto: () => getSetting<boolean>(AUTO_KEY, true) !== false,
  lastCheck: () => {
    const v = getStateValue<unknown>(LAST_CHECK_KEY, 0);
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  },
  setLastCheck: (ms) => setStateValues({ [LAST_CHECK_KEY]: ms }).catch(() => {}),
  skipped: () => {
    const v = getStateValue<unknown>(SKIPPED_KEY, null);
    return typeof v === "string" && v ? v : null;
  },
  setSkipped: (version) => setStateValues({ [SKIPPED_KEY]: version ?? "" }).catch(() => {}),
  // The page's own run, or anything else holding Rust's one run slot (a sweep, a run adopted late).
  runActive: async () => getRunState().active !== null || (await api.runActive().catch(() => null)) !== null,
  stopRun: () => stopRun(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

let flow = new UpdateFlow(appSource, appEnv);
const flowListeners = new Set<() => void>();
let unsubscribe = flow.subscribe(() => flowListeners.forEach((l) => l()));

export function updateFlow(): UpdateFlow {
  return flow;
}

/** For tests: a fresh flow over the app's source, or over the fakes given. */
export function resetUpdates(source: UpdateSource = appSource, env: UpdateEnv = appEnv) {
  unsubscribe();
  flow = new UpdateFlow(source, env);
  unsubscribe = flow.subscribe(() => flowListeners.forEach((l) => l()));
  flowListeners.forEach((l) => l());
}

function usePhase(): UpdatePhase {
  return useSyncExternalStore(
    (l) => {
      flowListeners.add(l);
      return () => flowListeners.delete(l);
    },
    () => flow.get(),
  );
}

/** Qnet ▸ Check for Updates…, and the once-a-day check when Qnet starts. */
export function useUpdateCommands() {
  useCommands(
    [
      {
        id: "app:check-updates",
        title: t.menuTitle,
        group: t.group,
        subtitle: t.menuHelp,
        icon: RefreshCw,
        keywords: ["update", "upgrade", "version", "new", "release"],
        run: () => void flow.checkNow(),
      },
    ],
    [],
  );
  useEffect(() => {
    let alive = true;
    // The setting and the day of the last check are read from the stores first.
    void loadKv()
      .catch(() => {})
      .then(() => (alive ? flow.checkAtLaunch() : false))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
}

interface SheetButton {
  id: string;
  label: string;
  run: () => void;
  role?: "default" | "cancel";
  disabled?: boolean;
}

interface Sheet {
  tone: "info" | "crit";
  icon: typeof Info;
  title: string;
  body: string;
  buttons: SheetButton[];
}

function sheetFor(p: UpdatePhase): Sheet | null {
  const f = flow;
  const ok: SheetButton = { id: "ok", label: t.ok, role: "default", run: () => f.dismiss() };
  switch (p.phase) {
    case "idle":
      return null;
    case "disabled":
      return { tone: "info", icon: Info, title: t.disabledTitle, body: t.disabledBody, buttons: [{ ...ok, role: "default" }] };
    case "checking":
      return { tone: "info", icon: RefreshCw, title: t.checkingTitle, body: t.checkingBody, buttons: [{ id: "cancel", label: t.cancel, role: "cancel", run: () => f.dismiss() }] };
    case "upToDate":
      return { tone: "info", icon: Info, title: t.upToDateTitle, body: t.upToDateBody(p.currentVersion), buttons: [ok] };
    case "available":
      return {
        tone: "info",
        icon: CircleArrowDown,
        title: t.availableTitle(p.info.version),
        body: t.availableBody(p.currentVersion, p.info.date),
        buttons: [
          { id: "skip", label: t.skip, run: () => void f.skip() },
          { id: "later", label: t.later, role: "cancel", run: () => f.dismiss() },
          { id: "install", label: t.install, role: "default", run: () => void f.install() },
        ],
      };
    case "deferred":
      return p.before === "install"
        ? {
            tone: "info",
            icon: Info,
            title: t.waitInstallTitle,
            body: t.waitInstallBody(p.info.version),
            buttons: [
              { id: "stop", label: t.stopAndInstall, disabled: p.stopping, run: () => void f.stopRunAndContinue() },
              { id: "later", label: t.notNow, role: "cancel", run: () => f.postpone() },
            ],
          }
        : {
            tone: "info",
            icon: Info,
            title: t.waitRelaunchTitle(p.info.version),
            body: t.waitRelaunchBody,
            buttons: [
              { id: "stop", label: t.stopAndRelaunch, disabled: p.stopping, run: () => void f.stopRunAndContinue() },
              { id: "later", label: t.relaunchLater, role: "cancel", run: () => f.postpone() },
            ],
          };
    case "downloading":
      return { tone: "info", icon: CircleArrowDown, title: t.downloadingTitle(p.info.version), body: t.downloadingBody, buttons: [] };
    case "relaunching":
      return { tone: "info", icon: RefreshCw, title: t.relaunchingTitle, body: t.relaunchingBody, buttons: [] };
    case "ready":
      return {
        tone: "info",
        icon: Info,
        title: t.readyTitle(p.info.version),
        body: t.readyBody,
        buttons: [
          { id: "later", label: t.later, role: "cancel", run: () => f.dismiss() },
          { id: "relaunch", label: t.relaunchNow, role: "default", run: () => void f.relaunch() },
        ],
      };
    case "error":
      return {
        tone: "crit",
        icon: OctagonAlert,
        title: t.errorTitle,
        body: p.message || t.errorFallback,
        buttons: p.retry ? [{ ...ok, role: "cancel" }, { id: "retry", label: t.tryAgain, role: "default", run: () => void f.install() }] : [ok],
      };
  }
}

const FOCUSABLE = "button:not(:disabled), summary, [tabindex]:not([tabindex='-1'])";

function UpdateSheet({ p, sheet }: { p: UpdatePhase; sheet: Sheet }) {
  const ref = useRef<HTMLDivElement>(null);
  const cancel = sheet.buttons.find((b) => b.role === "cancel") ?? (sheet.buttons.length === 1 ? sheet.buttons[0] : undefined);
  const primary = sheet.buttons.find((b) => b.role === "default") ?? sheet.buttons[sheet.buttons.length - 1];
  const Icon = sheet.icon;

  // Modal over the main window for as long as it is up: commands that open panels wait (MENU-198).
  useEffect(() => holdModal(), []);
  useLayoutEffect(() => {
    const doc = ref.current?.ownerDocument;
    const app = doc?.querySelector(".app");
    if (!app) return;
    // What had the keyboard before the sheet took it gets it back when the sheet goes.
    const before = doc?.activeElement;
    app.setAttribute("inert", "");
    return () => {
      app.removeAttribute("inert");
      const view = doc?.defaultView;
      if (view && before instanceof view.HTMLElement && before !== doc.body && before.isConnected) before.focus({ preventScroll: true });
    };
  }, []);
  // Each step puts focus on its own default button (or on the sheet, when it has none) and is read out.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    (el.querySelector<HTMLElement>("[data-default]:not(:disabled)") ?? el).focus({ preventScroll: true });
    announce(`${sheet.title} ${sheet.body}`);
  }, [p.phase, p.phase === "deferred" ? p.before : ""]);
  useEffect(() => {
    const win = ref.current?.ownerDocument.defaultView;
    if (!win) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "Escape" || (e.key === "." && e.metaKey)) && cancel) {
        e.preventDefault();
        e.stopPropagation();
        cancel.run();
      }
    };
    win.addEventListener("keydown", onKey, true);
    return () => win.removeEventListener("keydown", onKey, true);
  });

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== "Tab") return;
    const doc = ref.current?.ownerDocument;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    e.preventDefault();
    if (!items.length || !doc) return;
    const i = items.indexOf(doc.activeElement as HTMLElement);
    items[e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === items.length - 1 ? 0 : i + 1].focus();
  };

  const fraction = p.phase === "downloading" && p.total ? Math.min(1, p.downloaded / p.total) : null;
  return (
    <div className="sb-overlay" data-shell-overlay>
      <div ref={ref} className="sb-dialog modal upd-dialog" role="dialog" aria-modal="true" aria-labelledby="upd-title" aria-describedby="upd-body" tabIndex={-1} data-phase={p.phase} onKeyDown={onKeyDown}>
        <Icon className={`sb-dialog-icon ${sheet.tone}`} size={32} strokeWidth={1.75} aria-hidden />
        <div className="sb-dialog-main">
          <h2 id="upd-title" className="sb-dialog-title">{sheet.title}</h2>
          <div id="upd-body" className="sb-dialog-body">{sheet.body}</div>
          {p.phase === "available" && (
            <>
              <h3 id="upd-notes-label" className="upd-notes-label">{t.notesLabel}</h3>
              <div className="upd-notes" role="region" aria-labelledby="upd-notes-label" tabIndex={0}>
                {p.info.notes ? <ReleaseNotes notes={p.info.notes} /> : <p className="muted">{t.noNotes}</p>}
              </div>
            </>
          )}
          {p.phase === "downloading" && (
            <div className="upd-progress">
              <div
                className="upd-bar"
                role="progressbar"
                aria-label={t.progressLabel}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
                aria-valuetext={t.progress(p.downloaded, p.total)}
              >
                <div className="upd-bar-fill" style={{ width: `${Math.round((fraction ?? 0) * 100)}%` }} />
              </div>
              <span className="upd-progress-text">{t.progress(p.downloaded, p.total)}</span>
            </div>
          )}
          {p.phase === "error" && p.detail && (
            <details className="sb-dialog-details">
              <summary><ChevronRight size={12} className="sb-disclosure" aria-hidden />{t.details}</summary>
              <div className="sb-dialog-details-box"><div className="sb-dialog-details-text">{p.detail}</div></div>
            </details>
          )}
          {sheet.buttons.length > 0 && (
            <div className="sb-dialog-actions">
              <span className="spacer" />
              {sheet.buttons.map((b) => (
                <button key={b.id} type="button" data-button={b.id} data-default={b === primary ? "" : undefined} className={`btn${b === primary ? " primary" : ""}`} disabled={b.disabled} onClick={b.run}>
                  {b.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The update sheet, over the main window, while the flow has something to say. */
export function UpdateHost() {
  const p = usePhase();
  const sheet = sheetFor(p);
  if (!sheet) return null;
  return createPortal(<UpdateSheet p={p} sheet={sheet} />, document.body);
}
