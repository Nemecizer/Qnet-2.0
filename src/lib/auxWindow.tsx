// Auxiliary windows: Settings, the detached panes, and later Help, About and the panels.
//
// `<AuxWindow>` opens a native window with `window.open` (src-tauri/src/windows.rs names it
// `aux-<name>` and applies its minimum size) and renders its children into that window from this
// window's React tree, through a portal. So a detached Status pane is the same component, with
// the same stores, as the docked one: nothing is copied between windows, and closing the window
// (its close button, Escape, ⌘W) calls `onClose`, which decides what happens next (a detached
// pane returns to the main window). The page's stylesheets and theme attributes are mirrored
// into the window and kept in step.
//
// In a plain browser (mock.html) the same code opens a pop-up window, so the preview works too.
import { installRadioGroups } from "./radiogroups";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { trackFieldEdits } from "../editor/fieldEdits";
import { api } from "./api";

export interface AuxHandle {
  name: string;
  /** The native window's label in the app. */
  label: string;
  win: Window;
  /** Closes it as its close button would (onClose runs). */
  close: () => void;
}

const open = new Map<string, AuxHandle>();
let opened = 0;

/** The auxiliary window that has keyboard focus now, if one has (⌘W closes it, ledger WS-037). */
export function focusedAuxWindow(): AuxHandle | undefined {
  for (const h of open.values()) {
    try {
      if (!h.win.closed && h.win.document.hasFocus()) return h;
    } catch {
      // A window that went away mid-check.
    }
  }
  return undefined;
}

/** The open auxiliary window called `name`. */
export function auxWindow(name: string): AuxHandle | undefined {
  return open.get(name);
}

/** Brings an open auxiliary window forward; false when it isn't open. */
export function raiseAuxWindow(name: string): boolean {
  const h = open.get(name);
  if (!h || h.win.closed) return false;
  h.win.focus();
  return true;
}

/**
 * Closes an auxiliary window for good. In the app the web view's own `close()` only empties it —
 * the native window stays on screen — so Rust is asked to close the window as well.
 */
function closeWindow(label: string, win: Window) {
  try {
    win.close();
  } catch {
    // Already gone.
  }
  if ("__TAURI_INTERNALS__" in window) void api.auxClose(label).catch(() => {});
}

function mirrorStyles(from: Document, to: Document): () => void {
  const copy = (n: Node) => {
    if (n instanceof HTMLStyleElement) {
      const s = to.createElement("style");
      s.textContent = n.textContent;
      s.dataset.auxMirror = "";
      to.head.appendChild(s);
    } else if (n instanceof HTMLLinkElement && n.rel === "stylesheet") {
      const l = to.createElement("link");
      l.rel = "stylesheet";
      l.href = n.href;
      to.head.appendChild(l);
    }
  };
  from.head.querySelectorAll("style, link[rel=stylesheet]").forEach(copy);
  const copyAttrs = () => {
    for (const a of [...from.documentElement.attributes]) to.documentElement.setAttribute(a.name, a.value);
    for (const a of [...to.documentElement.attributes]) if (!from.documentElement.hasAttribute(a.name)) to.documentElement.removeAttribute(a.name);
  };
  copyAttrs();
  // Styles that load later (a lazily imported module's CSS, Vite's hot reload) follow.
  const heads = new MutationObserver((records) => {
    for (const r of records) r.addedNodes.forEach(copy);
    // Hot reload rewrites a style's text in place: re-mirror everything when that happens.
    if (records.some((r) => r.type === "characterData" || (r.target instanceof HTMLStyleElement && r.type === "childList" && !r.addedNodes.length))) {
      to.head.querySelectorAll("[data-aux-mirror]").forEach((s) => s.remove());
      from.head.querySelectorAll("style").forEach(copy);
    }
  });
  heads.observe(from.head, { childList: true, subtree: true, characterData: true });
  const attrs = new MutationObserver(copyAttrs);
  attrs.observe(from.documentElement, { attributes: true });
  return () => {
    heads.disconnect();
    attrs.disconnect();
  };
}

export interface AuxWindowProps {
  /** `[a-z0-9-]`, unique: "settings", "pane-status". */
  name: string;
  title: string;
  size: [number, number];
  minSize?: [number, number];
  /** The window was closed by the user (close button, Escape, ⌘W) or failed to open. */
  onClose: () => void;
  /** Escape closes it (0.90.34 `AuxiliaryWindow.escapeClosesWindow`, ledger KEY-030); default true. */
  escapeCloses?: boolean;
  /** Called once the window exists, with it (to focus a field, say). */
  onOpen?: (win: Window) => void;
  /** Asked before ⌘W or Close Window closes it; false keeps it open (a form's unsaved-draft prompt). */
  shouldClose?: () => boolean;
  children: ReactNode;
}

/** Renders `children` in a window of their own for as long as it is mounted. */
export function AuxWindow({ name, title, size, minSize, onClose, escapeCloses = true, onOpen, shouldClose, children }: AuxWindowProps) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const shouldCloseRef = useRef(shouldClose);
  shouldCloseRef.current = shouldClose;
  const winRef = useRef<Window | null>(null);

  useLayoutEffect(() => {
    // The id makes the native window's label ours to know (src-tauri/src/windows.rs), so exactly
    // this window is closed later — not one opened under the same name a moment afterwards.
    const id = `${Date.now().toString(36)}${(opened++).toString(36)}`;
    const label = `aux-${name}-${id}`;
    const frag = `aux=${name}&id=${id}${minSize ? `&minw=${minSize[0]}&minh=${minSize[1]}` : ""}`;
    const win = window.open(`about:blank#${frag}`, `qnet-${name}`, `width=${size[0]},height=${size[1]}`);
    if (!win) {
      closeRef.current();
      return;
    }
    winRef.current = win;
    const doc = win.document;
    doc.title = title;
    const stopStyles = mirrorStyles(document, doc);
    // Edit ▸ Undo asks whether a field here has typing of its own to undo (src/editor/commands.ts).
    const stopFields = trackFieldEdits(doc);
    // Arrow keys and one Tab stop for the window's segmented controls (src/lib/radiogroups.ts).
    const stopRadios = installRadioGroups(doc);
    const stop = () => {
      stopStyles();
      stopFields();
      stopRadios();
    };
    const root = doc.createElement("div");
    root.className = "aux-root";
    doc.body.replaceChildren(root);
    let closedByUs = false;
    const handle: AuxHandle = {
      name,
      label,
      win,
      close: () => {
        // ⌘W and Close Window come here first: a form with an unsaved draft may refuse (WS-103).
        if (shouldCloseRef.current && !shouldCloseRef.current()) return;
        closedByUs = true;
        closeWindow(label, win);
        closeRef.current();
      },
    };
    open.set(name, handle);
    const onGone = () => {
      if (closedByUs) return;
      closedByUs = true;
      closeRef.current();
    };
    win.addEventListener("pagehide", onGone);
    win.addEventListener("beforeunload", onGone);
    setHost(root);
    onOpen?.(win);
    return () => {
      stop();
      win.removeEventListener("pagehide", onGone);
      win.removeEventListener("beforeunload", onGone);
      if (open.get(name) === handle) open.delete(name);
      closedByUs = true;
      setHost(null);
      closeWindow(label, win);
    };
  }, [name]);

  useEffect(() => {
    if (winRef.current) winRef.current.document.title = title;
  }, [title]);

  useEffect(() => {
    const win = winRef.current;
    if (!win || !escapeCloses) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      // A text field or an open alert takes Escape first.
      if (win.document.querySelector(".sb-overlay")) return;
      e.preventDefault();
      open.get(name)?.close();
    };
    win.addEventListener("keydown", onKey);
    return () => win.removeEventListener("keydown", onKey);
  }, [host, escapeCloses]);

  return host ? createPortal(children, host) : null;
}
