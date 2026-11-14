// The Shell transcript (shell.md §10, ledger SH-025…034, SET-187, WS-131, INV-024, INV-060).
//
// Bytes, not text: everything the terminal view is fed — the shell's own bytes exactly as the PTY
// delivered them, and under D1 the runs' output too, which never passes through the PTY — is
// captured here before xterm.js parses it, so colour, cursor motion and full-screen output
// round-trip on replay. The last 1 MiB is saved (src-tauri/src/shell.rs, `shell.savedRawBytes`
// in the data folder) every 10 s and at quit, and replayed at the next launch under a dated
// separator, after the reset codes 0.90.34 sent.
import { api } from "../../lib/api";
import { shellWords as w, shortDateTime } from "./words";

/** `maxCapturedBytes`. */
export const MAX_CAPTURED = 1_048_576;
/** The periodic backstop (crash, force quit). */
export const SAVE_INTERVAL_MS = 10_000;
/** The size the terminal is given before the replay, so it doesn't wrap at 2 columns. */
export const REPLAY_COLS = 120;
export const REPLAY_ROWS = 30;
/** Leave the alternate screen and bracketed paste, show the cursor, reset attributes. */
export const RESET_CODES = "\x1b[?1049l\x1b[?2004l\x1b[?25h\x1b[0m";

/** What follows the replayed bytes: two blank lines, the dim separator, two blank lines. */
export function replayTrailer(when: Date): string {
  return `\r\n\r\n\x1b[2m${w.separator(shortDateTime(when))}\x1b[0m\r\n\r\n`;
}

/** The captured stream: grows to 2 MiB, then keeps the last 1 MiB (`appendCapturedBytes`). */
export class Capture {
  private chunks: Uint8Array[] = [];
  private size = 0;
  /** Something arrived since the last save. */
  dirty = false;

  append(b: Uint8Array) {
    if (!b.length) return;
    this.chunks.push(b);
    this.size += b.length;
    this.dirty = true;
    if (this.size > 2 * MAX_CAPTURED) {
      const all = this.bytes();
      this.chunks = [all];
      this.size = all.length;
    }
  }

  /** The last MAX_CAPTURED bytes. */
  bytes(): Uint8Array {
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    if (out.length <= MAX_CAPTURED) return out;
    // Cut at a line start, so the replay never begins inside a character or an escape sequence.
    const tail = out.subarray(out.length - MAX_CAPTURED);
    const nl = tail.indexOf(0x0a);
    return nl < 0 ? tail.slice() : tail.slice(nl + 1);
  }

  get length(): number {
    return Math.min(this.size, MAX_CAPTURED);
  }

  clear() {
    this.chunks = [];
    this.size = 0;
    this.dirty = false;
  }
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(bin);
}

export function fromBase64(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Saves the capture. Nothing captured this launch leaves the last session's transcript alone
 * (SH-028); `force` saves even when nothing changed since the last save (quit).
 */
export async function saveCapture(c: Capture, force = false): Promise<boolean> {
  if (c.length === 0 || (!force && !c.dirty)) return false;
  c.dirty = false;
  try {
    return await api.shellTranscriptSave(toBase64(c.bytes()));
  } catch {
    c.dirty = true;
    return false;
  }
}

export async function loadTranscript(): Promise<Uint8Array | null> {
  try {
    const d = await api.shellTranscriptLoad();
    return d ? fromBase64(d) : null;
  } catch {
    return null;
  }
}
