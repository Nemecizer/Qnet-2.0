// A run's output in the Shell pane (decision D1, ledger SH-072…078, shell.md §6).
//
// 0.90.34 typed `bash "/tmp/BNET_run_….sh"` into the user's shell after ⌃E ⌃U (which threw away a
// half-typed line); the wrapper's first act was `printf '\033[A\033[2K'`, erasing that echoed
// command line, so the output appeared where the prompt had been, ended with "Elapsed time: …"
// and a blank line, and the shell then printed a fresh prompt below it.
//
// 2.0 starts runs itself and never types into the shell. Their bytes are written into the
// terminal *view* only, and keep 0.90.34's look without touching the shell:
//
// - The block takes the place of the live line (the prompt and whatever is typed after it, or
//   whatever row the shell's cursor is on): that line is lifted off the screen, the run's text is
//   written where it was, and the live line is put back underneath — the same prompt, colours,
//   half-typed command and cursor column — so the shell's line editor, which only ever moves
//   relative to its cursor, carries on as if nothing happened. This repeats for every chunk, so
//   the prompt stays live under a growing block and the user can keep typing (and running
//   commands) during a run; what they run appears below the block's text so far.
// - A line the run hasn't finished (a progress bar redrawing itself with `\r ESC[K`) is kept and
//   rewritten in place on the next chunk, so the bar animates above the prompt. If something else
//   was printed between two chunks, the bar continues on a fresh line instead.
// - 0.90.34's leading `ESC[A ESC[2K` (still in its recorded display bytes) has no echoed command
//   to erase under D1 and is dropped; it would otherwise erase a line of the user's own output.
// - While a full-screen program (vim, less, htop) owns the screen, run text is held and written
//   when it leaves, never painted over the program.
import type { IBufferCell, IBufferLine, IMarker, Terminal } from "@xterm/xterm";

const LEGACY_ERASE = "\x1b[A\x1b[2K";
const RESET = "\x1b[0m";

/** SGR parameters for a cell's attributes ("" for the default). */
function sgrOf(c: IBufferCell): string {
  const p: (string | number)[] = [];
  if (c.isBold()) p.push(1);
  if (c.isDim()) p.push(2);
  if (c.isItalic()) p.push(3);
  if (c.isUnderline()) p.push(4);
  if (c.isBlink()) p.push(5);
  if (c.isInverse()) p.push(7);
  if (c.isInvisible()) p.push(8);
  if (c.isStrikethrough()) p.push(9);
  if (c.isOverline()) p.push(53);
  if (c.isFgPalette()) {
    const n = c.getFgColor();
    p.push(n < 8 ? 30 + n : n < 16 ? 90 + n - 8 : `38;5;${n}`);
  } else if (c.isFgRGB()) {
    const n = c.getFgColor();
    p.push(`38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`);
  }
  if (c.isBgPalette()) {
    const n = c.getBgColor();
    p.push(n < 8 ? 40 + n : n < 16 ? 100 + n - 8 : `48;5;${n}`);
  } else if (c.isBgRGB()) {
    const n = c.getBgColor();
    p.push(`48;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`);
  }
  return p.join(";");
}

/** One buffer row as text with its colours; `trim` drops trailing default blanks. */
export function serializeRow(line: IBufferLine | undefined, cols: number, trim: boolean, cell?: IBufferCell): string {
  if (!line) return "";
  let end = cols;
  if (trim) {
    end = 0;
    for (let x = cols - 1; x >= 0; x--) {
      const c = line.getCell(x, cell);
      if (!c) continue;
      if ((c.getChars() !== "" && c.getChars() !== " ") || !c.isBgDefault() || c.isInverse()) {
        end = x + c.getWidth();
        break;
      }
    }
  }
  let out = "";
  let attrs = "";
  for (let x = 0; x < end; x++) {
    const c = line.getCell(x, cell);
    if (!c || c.getWidth() === 0) continue;
    const a = sgrOf(c);
    if (a !== attrs) {
      out += a ? `\x1b[0;${a}m` : RESET;
      attrs = a;
    }
    out += c.getChars() || " ";
  }
  return attrs ? out + RESET : out;
}

/** The live line: the cursor's row and the rows it wraps to or from. */
export interface LiveLine {
  /** Absolute buffer rows. */
  start: number;
  end: number;
  cursorRow: number;
  cursorX: number;
  /** The rows serialized: full width but the last, trimmed. */
  text: string;
}

export function captureLiveLine(term: Terminal): LiveLine {
  const b = term.buffer.active;
  const cursorRow = b.baseY + b.cursorY;
  let start = cursorRow;
  while (start > 0 && b.getLine(start)?.isWrapped) start--;
  let end = cursorRow;
  while (b.getLine(end + 1)?.isWrapped) end++;
  const cell = b.getNullCell();
  let text = "";
  for (let r = start; r <= end; r++) text += serializeRow(b.getLine(r), term.cols, r === end, cell);
  return { start, end, cursorRow, cursorX: b.cursorX, text };
}

/** Lone LFs become CR LF: the runner's text never went through a terminal's onlcr. */
export function crlf(s: string): string {
  return s.replace(/\r?\n/g, "\r\n");
}

/** What follows the last full-line erase of an unfinished line (a progress bar's latest frame). */
export function latestFrame(partial: string): string {
  let at = -1;
  for (const e of ["\r\x1b[K", "\r\x1b[0K", "\r\x1b[2K"]) at = Math.max(at, partial.lastIndexOf(e));
  return at > 0 ? partial.slice(at) : partial;
}

/** A step of a write: text for the terminal, or a function that runs once everything before it is drawn. */
export type Step = string | (() => string | void);

/** One run's block in the view. */
export class RunBlock {
  private atStart = true;
  private pending = "";
  private partial = "";
  private partialMarker: IMarker | null = null;
  private partialRows = 0;
  private decoder = new TextDecoder();

  /** Decodes a chunk of run bytes (UTF-8 split across chunks is kept). */
  decode(bytes: Uint8Array): string {
    return this.decoder.decode(bytes, { stream: true });
  }

  /** Drops 0.90.34's leading erase of the echoed command; "" while it can't tell yet. */
  private strip(text: string): string {
    if (!this.atStart) return text;
    this.pending += text;
    if (this.pending.length < LEGACY_ERASE.length && LEGACY_ERASE.startsWith(this.pending)) return "";
    const t = this.pending.startsWith(LEGACY_ERASE) ? this.pending.slice(LEGACY_ERASE.length) : this.pending;
    this.atStart = false;
    this.pending = "";
    return t;
  }

  /**
   * The writes that put `text` into the view above the live line. Call it when every earlier
   * write has been drawn (the buffer is current); the steps are written in order, each function
   * step once what precedes it is drawn.
   */
  steps(term: Terminal, chunk: string): Step[] {
    const text = this.strip(chunk);
    if (!text) return [];
    const live = captureLiveLine(term);
    const m = this.partialMarker;
    const adjacent = !!m && !m.isDisposed && this.partial !== "" && m.line + this.partialRows === live.start;
    const top = adjacent ? m!.line : live.start;
    const up = live.cursorRow - top;
    // Lift the live line (and, when it's right above, the unfinished run line) off the screen.
    const lift = `\r${up > 0 ? `\x1b[${up}A` : ""}\x1b[J`;
    const full = this.partial + text;
    const nl = full.lastIndexOf("\n");
    const complete = nl >= 0 ? full.slice(0, nl + 1) : "";
    const rest = latestFrame(nl >= 0 ? full.slice(nl + 1) : full);
    this.partial = rest;
    let liveTop = 0;
    const steps: Step[] = [lift + crlf(complete)];
    if (rest) {
      steps.push(() => {
        this.partialMarker?.dispose();
        this.partialMarker = term.registerMarker(0) ?? null;
      });
      steps.push(rest + RESET);
      steps.push(() => {
        const b = term.buffer.active;
        this.partialRows = b.baseY + b.cursorY - (this.partialMarker?.line ?? b.baseY + b.cursorY) + 1;
      });
      steps.push("\r\n");
    } else {
      this.partialMarker?.dispose();
      this.partialMarker = null;
      this.partialRows = 0;
      steps.push(RESET);
    }
    // Put the live line back and its cursor where the shell left it.
    steps.push(() => {
      const b = term.buffer.active;
      liveTop = b.baseY + b.cursorY;
    });
    steps.push(live.text);
    steps.push(() => {
      const b = term.buffer.active;
      const now = b.baseY + b.cursorY;
      const target = liveTop + (live.cursorRow - live.start);
      const d = now - target;
      return `${d > 0 ? `\x1b[${d}A` : d < 0 ? `\x1b[${-d}B` : ""}\x1b[${live.cursorX + 1}G`;
    });
    return steps;
  }

  /** The run ended: the next output starts a new block. */
  end() {
    this.partialMarker?.dispose();
    this.partialMarker = null;
    this.partialRows = 0;
    this.partial = "";
    this.pending = "";
    this.atStart = true;
    this.decoder = new TextDecoder();
  }
}
