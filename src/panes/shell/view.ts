// The Shell's terminal view (shell.md §3–§5, §9; ledger SH-012, SH-015…061, WS-056, INV-008).
//
// One xterm.js terminal per app, made the first time the Shell pane is shown (SH-011) and kept
// here, outside React, for the life of the page: the pane's component only moves `root` into
// its body. Hiding, showing, maximizing another pane and detaching the Shell into its own window
// re-parent the same element, so the shell process, its scrollback and a run's output survive
// every layout change; only Restart Shell starts a new shell (SH-037).
//
// Everything the view shows goes through one queue, in order: the PTY's bytes, a run's output
// (decision D1: written into the view, never into the shell — runBlock.ts), Clear's sequences.
// Every byte is measured (meter.ts) and captured for the transcript (transcript.ts) on its way in.
//
// Width (§4, SH-052): 0.90.34 never hard-wrapped long output — a 200-column table widened the
// terminal past the pane and engaged a horizontal scroller. xterm.js wraps at its column count,
// so the terminal is given as many columns as the widest measured line needs (characters × cell
// width + 40, at least the pane's width) inside a horizontally scrolling box; a full-screen
// program (the alternate screen) gets the pane's own width, since it draws to fit.
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { api } from "../../lib/api";
import { invalidateMenu } from "../../lib/menu";
import { onRunFinished, onRunOutput } from "../../runs/state";
import { addStatus } from "../../workspace/store";
import { LineWidthMeter, minTerminalWidth } from "./meter";
import { RunBlock, type Step } from "./runBlock";
import { shellTheme, watchAppearance } from "./theme";
import { Capture, fromBase64, loadTranscript, replayTrailer, REPLAY_COLS, REPLAY_ROWS, RESET_CODES, saveCapture, SAVE_INTERVAL_MS } from "./transcript";
import { shellWords as w } from "./words";

/** `terminalLeadingInset`, `terminalBottomInset`. */
export const LEADING_INSET = 6;
export const BOTTOM_INSET = 10;
export const MIN_FONT = 8;
export const MAX_FONT = 28;
export const DEFAULT_FONT = 12;
/** `scrollerHideDelay`. */
export const SCROLLER_HIDE_MS = 1000;
export const SCROLLBACK = 5000;
export const MONO_STACK = 'ui-monospace, "SF Mono", Menlo, Monaco, monospace';

/** What the pane shows about the shell. */
export interface ShellSnapshot {
  started: boolean;
  running: boolean;
  exitCode: number | null;
  /** The working directory (OSC 7 keeps it current). */
  cwd: string;
  hasSelection: boolean;
  canScroll: boolean;
  /** The terminal is wider than the pane (the horizontal scroller is engaged). */
  overflow: boolean;
  findOpen: boolean;
  findTerm: string;
  /** The last find found nothing. */
  findMissed: boolean;
}

type Item =
  | { kind: "pty"; bytes: Uint8Array }
  | { kind: "run"; bytes: Uint8Array }
  | { kind: "end" }
  | { kind: "do"; run: () => void };

const enc = new TextEncoder();

/** The path an OSC 7 carries: a `file://host/path` URL or a bare path, percent-decoded. */
export function osc7Path(data: string): string | null {
  if (!data) return null;
  let path = data;
  const m = /^file:\/\/[^/]*(\/.*)?$/.exec(data);
  if (m) path = m[1] ?? "/";
  else if (data.startsWith("file:")) path = data.slice(5);
  try {
    path = decodeURIComponent(path);
  } catch {
    // Not valid percent-encoding: keep it as it came.
  }
  return path || null;
}

/** The home folder shortened to ~ (`abbreviatingWithTildeInPath`). */
export function abbreviate(path: string, home: string | null): string {
  if (!home || home === "/") return path;
  if (path === home) return "~";
  return path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

/** The header's directory, truncated in the middle (`.truncationMode(.middle)`). */
export function middleTruncate(s: string, max = 48): string {
  const chars = [...s];
  if (chars.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return chars.slice(0, head).join("") + "…" + chars.slice(chars.length - tail).join("");
}

export class ShellView {
  readonly term: Terminal;
  readonly search = new SearchAddon();
  readonly root: HTMLDivElement;
  readonly scroller: HTMLDivElement;
  readonly host: HTMLDivElement;
  readonly vbar: HTMLDivElement;
  readonly vthumb: HTMLDivElement;
  readonly meter = new LineWidthMeter();
  readonly capture = new Capture();
  private block = new RunBlock();
  private queue: Item[] = [];
  private busy = false;
  private heldRun: Item[] = [];
  private lastRunKey: string | null = null;
  private token = 0;
  private generation = 0;
  private opened = false;
  private starting: Promise<void> | null = null;
  private snap: ShellSnapshot = { started: false, running: false, exitCode: null, cwd: "", hasSelection: false, canScroll: false, overflow: false, findOpen: false, findTerm: "", findMissed: false };
  private listeners = new Set<() => void>();
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private vHovered = false;
  private settings = { fontSize: DEFAULT_FONT, fontName: "", classic: false };
  private stops: (() => void)[] = [];
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  /** For the tests: how the size was decided last. */
  lastLayout = { usable: 0, target: 0, cols: 0, rows: 0 };

  constructor() {
    this.term = new Terminal({
      cols: REPLAY_COLS,
      rows: REPLAY_ROWS,
      scrollback: SCROLLBACK,
      cursorStyle: "block",
      cursorBlink: true,
      fontSize: DEFAULT_FONT,
      fontFamily: MONO_STACK,
      // Option is Meta, SwiftTerm's default (SH-016).
      macOptionIsMeta: true,
      allowProposedApi: true,
    });
    this.term.loadAddon(this.search);
    // ⌘-click opens a link with the default app (SH-019).
    this.term.loadAddon(
      new WebLinksAddon((e, uri) => {
        if (!e.metaKey) return;
        void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(uri)).catch(() => {});
      }),
    );
    const doc = document;
    this.root = doc.createElement("div");
    this.root.className = "shell-view";
    this.root.setAttribute("role", "group");
    this.root.setAttribute("aria-label", w.paneLabel);
    this.scroller = doc.createElement("div");
    this.scroller.className = "shell-scroller";
    this.scroller.setAttribute("aria-label", w.hScrollLabel);
    this.host = doc.createElement("div");
    this.host.className = "shell-term";
    this.scroller.appendChild(this.host);
    this.vbar = doc.createElement("div");
    this.vbar.className = "shell-vscroll";
    this.vbar.setAttribute("role", "scrollbar");
    this.vbar.setAttribute("aria-orientation", "vertical");
    this.vbar.setAttribute("aria-label", w.vScrollLabel);
    // A scrollbar has a value from the start (it was set only on the first scroll).
    this.vbar.setAttribute("aria-valuemin", "0");
    this.vbar.setAttribute("aria-valuemax", "100");
    this.vbar.setAttribute("aria-valuenow", "0");
    this.vthumb = doc.createElement("div");
    this.vthumb.className = "shell-vthumb";
    this.vbar.appendChild(this.vthumb);
    this.root.append(this.scroller, this.vbar);

    const t = this.term;
    t.onData((d) => this.input(d, false));
    t.onBinary((d) => this.input(d, true));
    t.onResize(({ cols, rows }) => {
      if (this.snap.running) void api.shellResize(cols, rows).catch(() => {});
    });
    t.onSelectionChange(() => {
      const has = t.hasSelection();
      if (has !== this.snap.hasSelection) {
        this.set({ hasSelection: has });
        invalidateMenu();
      }
    });
    t.onScroll(() => {
      this.syncVbar();
      this.revealScrollers();
    });
    t.onWriteParsed(() => this.syncVbar());
    t.buffer.onBufferChange((b) => {
      // A full-screen program came or went: the width follows, and held run text is written.
      if (b.type === "normal" && this.heldRun.length) {
        this.queue.unshift(...this.heldRun);
        this.heldRun = [];
        this.pump();
      }
      this.layout();
    });
    // OSC 7: the header's directory follows `cd` (SH-008). Window titles are ignored (SH-023).
    t.parser.registerOscHandler(7, (data) => {
      const p = osc7Path(data);
      if (p && p !== this.snap.cwd) this.set({ cwd: p });
      return true;
    });
    this.wireChrome();
  }

  // ── State for the pane ────────────────────────────────────────────────────────────────────

  snapshot = (): ShellSnapshot => this.snap;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(patch: Partial<ShellSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((l) => l());
  }

  // ── Mounting ──────────────────────────────────────────────────────────────────────────────

  /** Moves the view into `container` (the pane's body, docked or in its own window). */
  attach(container: HTMLElement) {
    if (this.root.parentElement !== container) container.appendChild(this.root);
    if (!this.opened) {
      this.opened = true;
      this.term.open(this.host);
      const ta = this.term.textarea;
      if (ta) {
        ta.setAttribute("aria-label", w.terminalLabel);
        ta.setAttribute("aria-description", w.terminalHelp);
        ta.title = w.terminalHelp;
      }
    }
    this.layout();
  }

  /** The pane's component unmounted: the view (and the shell) stay. */
  detach(container: HTMLElement) {
    if (this.root.parentElement === container) container.removeChild(this.root);
  }

  private wireChrome() {
    const r = this.root;
    const ro = new ResizeObserver(() => this.layout());
    ro.observe(r);
    this.stops.push(() => ro.disconnect());
    // A mostly-horizontal wheel or trackpad gesture pans the wide terminal (SH-057).
    r.addEventListener(
      "wheel",
      (e) => {
        const dx = e.deltaMode === 1 ? e.deltaX * 10 : e.deltaX;
        if (Math.abs(dx) <= Math.abs(e.deltaY) || dx === 0 || !this.snap.overflow) return;
        this.scroller.scrollLeft += dx;
        e.preventDefault();
        e.stopPropagation();
      },
      { capture: true, passive: false },
    );
    // ⌘C with no selection copies nothing: xterm.js would put an empty string on the clipboard.
    r.addEventListener("copy", (e) => {
      if (!this.term.hasSelection()) e.stopPropagation();
    }, true);
    // Nothing is dropped onto the terminal (SH-022).
    for (const ev of ["dragover", "drop"]) r.addEventListener(ev, (e) => e.preventDefault(), true);
    // The vertical overlay scroller: fades in on activity, stays while hovered (SH-058).
    this.vbar.addEventListener("pointerenter", () => {
      this.vHovered = true;
      this.revealScrollers();
    });
    this.vbar.addEventListener("pointerleave", () => {
      this.vHovered = false;
      this.revealScrollers();
    });
    this.vbar.addEventListener("pointerdown", (e) => this.vbarPointer(e));
    this.scroller.addEventListener("scroll", () => this.revealScrollers());
    const unwatch = watchAppearance(() => this.applyTheme());
    this.stops.push(unwatch);
  }

  private vbarPointer(e: PointerEvent) {
    const b = this.term.buffer.active;
    if (b.baseY <= 0) return;
    e.preventDefault();
    const track = this.vbar.getBoundingClientRect();
    const thumb = this.vthumb.getBoundingClientRect();
    if (e.target !== this.vthumb) {
      this.term.scrollPages(e.clientY < thumb.top ? -1 : 1);
      return;
    }
    const grab = e.clientY - thumb.top;
    const move = (ev: PointerEvent) => {
      const span = track.height - thumb.height;
      const frac = span > 0 ? Math.min(1, Math.max(0, (ev.clientY - grab - track.top) / span)) : 1;
      this.term.scrollToLine(Math.round(frac * this.term.buffer.active.baseY));
    };
    const up = () => {
      this.vbar.ownerDocument.removeEventListener("pointermove", move);
      this.vbar.ownerDocument.removeEventListener("pointerup", up);
    };
    this.vbar.ownerDocument.addEventListener("pointermove", move);
    this.vbar.ownerDocument.addEventListener("pointerup", up);
  }

  private revealScrollers() {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    if (this.snap.canScroll) this.vbar.dataset.visible = "true";
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      if (!this.vHovered) delete this.vbar.dataset.visible;
    }, SCROLLER_HIDE_MS);
  }

  private syncVbar() {
    const b = this.term.buffer.active;
    const canScroll = b.type === "normal" && b.baseY > 0;
    if (canScroll !== this.snap.canScroll) this.set({ canScroll });
    this.vbar.dataset.enabled = canScroll ? "true" : "false";
    if (!canScroll) {
      delete this.vbar.dataset.visible;
      return;
    }
    const total = b.length;
    const size = Math.max(0.05, Math.min(1, this.term.rows / total));
    const pos = b.baseY > 0 ? b.viewportY / b.baseY : 1;
    this.vthumb.style.height = `${size * 100}%`;
    this.vthumb.style.top = `${pos * (1 - size) * 100}%`;
    this.vbar.setAttribute("aria-valuenow", String(Math.round(pos * 100)));
  }

  // ── Size ──────────────────────────────────────────────────────────────────────────────────

  /** The terminal's cell, in CSS pixels (xterm's own measurement; an estimate before it has one). */
  cellSize(): { width: number; height: number } {
    const d = (this.term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } } })._core?._renderService?.dimensions?.css?.cell;
    const fs = this.settings.fontSize;
    return { width: d && d.width > 0 ? d.width : fs * 0.62, height: d && d.height > 0 ? d.height : Math.ceil(fs * 1.2) };
  }

  /** Sizes the terminal to the pane, widened for the longest measured line (`layoutTerminal`). */
  layout() {
    if (!this.opened || !this.root.isConnected) return;
    const usable = Math.max(0, this.root.clientWidth - LEADING_INSET);
    const avail = Math.max(0, this.root.clientHeight - BOTTOM_INSET);
    if (usable <= 0 || avail <= 0) return;
    const cell = this.cellSize();
    const alt = this.term.buffer.active.type === "alternate";
    const target = Math.max(alt ? 0 : minTerminalWidth(this.meter.longest, cell.width), usable);
    this.host.style.width = `${target}px`;
    const cols = Math.max(2, Math.floor(target / cell.width));
    const rows = Math.max(1, Math.floor(avail / cell.height));
    if (cols !== this.term.cols || rows !== this.term.rows) this.term.resize(cols, rows);
    const overflow = target > usable + 0.5;
    if (!overflow) this.scroller.scrollLeft = 0;
    if (overflow !== this.snap.overflow) this.set({ overflow });
    this.lastLayout = { usable, target, cols, rows };
    this.syncVbar();
  }

  // ── Settings ──────────────────────────────────────────────────────────────────────────────

  applySettings(s: { fontSize: number; fontName: string; classic: boolean }) {
    const fontSize = Math.min(MAX_FONT, Math.max(MIN_FONT, Number(s.fontSize) || DEFAULT_FONT));
    const changed = fontSize !== this.settings.fontSize || s.fontName !== this.settings.fontName;
    const themeChanged = s.classic !== this.settings.classic;
    this.settings = { fontSize, fontName: s.fontName, classic: s.classic };
    if (changed) {
      this.term.options.fontSize = fontSize;
      // An uninstalled family falls back to the system's monospaced face (SH-066).
      this.term.options.fontFamily = s.fontName ? `"${s.fontName}", ${MONO_STACK}` : MONO_STACK;
      // The width in pixels follows the new advance, so the scroller can retract (SH-056).
      this.layout();
      requestAnimationFrame(() => this.layout());
    }
    if (themeChanged || !this.themed) this.applyTheme();
  }

  private themed = false;
  private applyTheme() {
    this.themed = true;
    const theme = shellTheme(this.settings.classic);
    this.term.options.theme = theme;
    this.root.dataset.theme = this.settings.classic ? "classic" : "system";
    if (theme.background) this.root.style.setProperty("--shell-ground", theme.background);
  }

  // ── The shell process ─────────────────────────────────────────────────────────────────────

  /** First show: replays the saved transcript, then starts the shell (or re-attaches to it). */
  start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      // The last session's transcript first: run output that arrived before the pane existed (held
      // by src/runs/state.ts) goes after it, in the order it happened.
      const saved = await loadTranscript();
      if (saved) await this.replay(saved, new Date());
      this.stops.push(onRunOutput((bytes, meta) => this.runOutput(bytes, meta)));
      this.stops.push(onRunFinished(() => this.endRun()));
      this.saveTimer = setInterval(() => void saveCapture(this.capture), SAVE_INTERVAL_MS);
      await this.spawn();
    })();
    return this.starting;
  }

  /** The replay of the last session (§10): pre-sized 120 × 30, reset codes, the dated separator. */
  replay(saved: Uint8Array, when: Date): Promise<void> {
    return new Promise((resolve) => {
      this.enqueue({
        kind: "do",
        run: () => {
          if (this.term.cols !== REPLAY_COLS || this.term.rows !== REPLAY_ROWS) this.term.resize(REPLAY_COLS, REPLAY_ROWS);
        },
      });
      this.enqueue({ kind: "pty", bytes: saved });
      this.enqueue({ kind: "pty", bytes: enc.encode(RESET_CODES + replayTrailer(when)) });
      this.enqueue({ kind: "do", run: () => (this.layout(), resolve()) });
    });
  }

  private async spawn() {
    const token = ++this.token;
    this.layout();
    try {
      const info = await api.shellStart(this.term.cols, this.term.rows, (m) => {
        if (token !== this.token) return;
        if (m.kind === "output") this.enqueue({ kind: "pty", bytes: fromBase64(m.data) });
        else if (m.generation === this.generation) this.set({ running: false, exitCode: m.code });
      });
      if (token !== this.token) return;
      this.generation = info.generation;
      this.set({ started: true, running: true, exitCode: null, cwd: this.snap.cwd || info.cwd });
      // The size may have moved while the shell was starting.
      void api.shellResize(this.term.cols, this.term.rows).catch(() => {});
    } catch (e) {
      this.set({ started: true, running: false });
      addStatus(w.startFailed(e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e)), "error");
    }
  }

  private input(data: string, binary: boolean) {
    if (!this.snap.running) return;
    void api.shellInput(data, binary).catch(() => {});
  }

  /** Restart: a new shell in an empty terminal; the old capture, width and selection go (SH-037). */
  async restart() {
    this.token++;
    // The capture goes first, so a 10-second save landing while the old shell stops can't write
    // the forgotten transcript back.
    this.capture.clear();
    await api.shellStop().catch(() => {});
    this.queue = this.queue.filter((i) => i.kind !== "pty");
    this.heldRun = [];
    this.term.reset();
    this.term.clearSelection();
    this.meter.reset();
    this.capture.clear();
    this.block.end();
    this.lastRunKey = null;
    this.set({ running: false, exitCode: null, hasSelection: false, cwd: "" });
    this.layout();
    invalidateMenu();
    if (this.starting) await this.spawn();
    else await this.start();
  }

  // ── Writing ───────────────────────────────────────────────────────────────────────────────

  /** A run's bytes for the view (what `onRunOutput` delivers). */
  runOutput(bytes: Uint8Array, meta: { tabId: string; method: string }) {
    const key = `${meta.tabId}\n${meta.method}`;
    if (this.lastRunKey !== null && this.lastRunKey !== key) this.enqueue({ kind: "end" });
    this.lastRunKey = key;
    this.enqueue({ kind: "run", bytes });
  }

  /** A run ended (what `onRunFinished` says): its next output starts a new block. */
  endRun() {
    this.enqueue({ kind: "end" });
  }

  private enqueue(i: Item) {
    if (i.kind === "end") this.lastRunKey = null;
    this.queue.push(i);
    this.pump();
  }

  /** Feeds bytes to the terminal, measuring and capturing them on the way. */
  private feed(data: Uint8Array | string, cb?: () => void) {
    const bytes = typeof data === "string" ? enc.encode(data) : data;
    this.capture.append(bytes);
    if (this.meter.scan(bytes) !== null) queueMicrotask(() => this.layout());
    this.term.write(data, cb);
  }

  private pump() {
    while (!this.busy && this.queue.length) {
      const item = this.queue.shift()!;
      switch (item.kind) {
        case "pty":
          this.feed(item.bytes);
          break;
        case "do":
          this.busy = true;
          this.term.write("", () => {
            item.run();
            this.busy = false;
            this.pump();
          });
          return;
        case "end":
          this.busy = true;
          this.term.write("", () => {
            this.block.end();
            this.busy = false;
            this.pump();
          });
          return;
        case "run":
          this.busy = true;
          // Wait until everything before it is drawn: the live line is read off the buffer.
          this.term.write("", () => {
            if (this.term.buffer.active.type === "alternate") {
              this.heldRun.push(item);
              this.busy = false;
              this.pump();
              return;
            }
            const steps = this.block.steps(this.term, this.block.decode(item.bytes));
            this.runSteps(steps, () => {
              this.busy = false;
              this.pump();
            });
          });
          return;
      }
    }
  }

  private runSteps(steps: Step[], done: () => void) {
    const next = () => {
      const s = steps.shift();
      if (s === undefined) return done();
      const text = typeof s === "string" ? s : s();
      if (text) this.feed(text, next);
      else next();
    };
    next();
  }

  /** Resolves once everything queued so far is drawn (the tests, the transcript at quit). */
  drained(): Promise<void> {
    return new Promise((resolve) => this.enqueue({ kind: "do", run: resolve }));
  }

  // ── Commands ──────────────────────────────────────────────────────────────────────────────

  /**
   * Clear Shell (⌘K, SH-035): erase the scrollback and the screen, scroll to the top, ⌃L so the
   * shell redraws its prompt, forget the captured bytes and the measured width. The shell keeps
   * running.
   */
  clear() {
    this.enqueue({
      kind: "do",
      run: () => {
        this.term.write("\x1b[3J\x1b[2J\x1b[H");
        this.term.scrollToTop();
        this.term.clearSelection();
        this.capture.clear();
        this.meter.clearScrollback();
        this.set({ hasSelection: false });
        this.layout();
        invalidateMenu();
        if (this.snap.running) void api.shellInput("\x0c").catch(() => {});
      },
    });
  }

  scrollToBottom() {
    this.term.scrollToBottom();
  }

  focus() {
    this.term.focus();
  }

  /** The selection, or "" (⌘C, the context menu: never the whole scrollback). */
  selection(): string {
    return this.term.hasSelection() ? this.term.getSelection().replace(/\0/g, "") : "";
  }

  /** The whole scrollback as text (`getBufferAsData`, NULs stripped). */
  scrollbackText(): string {
    const b = this.term.buffer.normal;
    const lines: string[] = [];
    for (let y = 0; y < b.length; y++) {
      const line = b.getLine(y);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n").replace(/\0/g, "");
  }

  selectAll() {
    this.term.selectAll();
  }

  /** Text into the shell as a paste (bracketed when the program asked for it, SH-021). */
  paste(text: string) {
    if (text) this.term.paste(text);
  }

  /** Mouse reporting is on (htop, vim, `less -R`): right-click belongs to the program (SH-047). */
  mouseReporting(): boolean {
    return this.term.modes.mouseTrackingMode !== "none";
  }

  // ── Find (§9.2) ───────────────────────────────────────────────────────────────────────────

  showFind() {
    this.set({ findOpen: true });
  }

  closeFind() {
    this.search.clearDecorations();
    this.set({ findOpen: false, findMissed: false });
    this.term.focus();
  }

  setFindTerm(term: string) {
    this.set({ findTerm: term, findMissed: false });
    invalidateMenu();
    if (term) this.findStep(1, true);
    else this.term.clearSelection();
  }

  /** ⌘G / ⇧⌘G: the next or previous match, without taking the keyboard from the find field. */
  findStep(delta: 1 | -1, incremental = false): boolean {
    const t = this.snap.findTerm;
    if (!t) return false;
    const found = delta > 0 ? this.search.findNext(t, { incremental }) : this.search.findPrevious(t);
    if (found === this.snap.findMissed) this.set({ findMissed: !found });
    return found;
  }

  // ── Transcript ────────────────────────────────────────────────────────────────────────────

  /** Saves the transcript now (quit: always, whatever the tab-restore answer). */
  async save(force = false): Promise<boolean> {
    return saveCapture(this.capture, force);
  }

  dispose() {
    this.token++;
    this.stops.forEach((s) => s());
    this.stops = [];
    if (this.saveTimer) clearInterval(this.saveTimer);
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.block.end();
    this.root.remove();
    this.term.dispose();
  }
}

let view: ShellView | null = null;

/** The app's one terminal view (made on first use). */
export function shellView(): ShellView {
  view ??= new ShellView();
  return view;
}

/** The view if the Shell has been shown this launch. */
export function existingShellView(): ShellView | null {
  return view;
}

/** For tests: forget the view (and its subscriptions). */
export function resetShellView() {
  view?.dispose();
  view = null;
}
