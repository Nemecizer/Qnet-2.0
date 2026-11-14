// The Shell's line-width meter (shell.md §4, ledger SH-052…055, INV-059): a port of 0.90.34's
// `TerminalLineWidthMeter`, byte for byte.
//
// "Measure the stream, not the buffer": the widest line is measured off the bytes the terminal
// view is fed, before xterm.js parses them, never off its reflowed buffer — a wider view would
// otherwise lengthen the lines it measures, and the width would chase itself. 0.90.34 measured on
// SwiftTerm's pty reader thread because its main-actor drain ran on a 10 s backstop; in 2.0 both
// streams that reach the view (the PTY's bytes and a run's output, which never passes through the
// PTY under D1) meet in the page, so the one meter sits there, in front of `term.write`.

/** Ceiling on a measured line, in characters (twice the widest table Qnet prints). */
export const MAX_MEASURED_COLUMNS = 240;

const enum S {
  Text,
  Escape,
  Csi,
  /** OSC / DCS / SOS / PM / APC payload, ended by BEL or ST. */
  Str,
  /** ESC seen inside a string payload: ST if "\" follows. */
  StrEscape,
}

export class LineWidthMeter {
  private state = S.Text;
  private column = 0;
  /** The furthest column this line has painted (BS moves the cursor without erasing). */
  private lineHighWater = 0;
  private peak = 0;
  private reportedPeak = 0;
  private altScreen = false;
  private params: number[] = [];
  private paramValue = 0;
  private paramHasDigits = false;
  private csiPrivate = false;

  /** Scans a chunk; the new peak when it grew past everything already reported, else null. */
  scan(bytes: Uint8Array): number | null {
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      switch (this.state) {
        case S.Text:
          this.text(b);
          break;
        case S.Escape:
          this.escape(b);
          break;
        case S.Csi:
          this.csi(b);
          break;
        case S.Str:
          if (b === 0x07) this.state = S.Text;
          else if (b === 0x1b) this.state = S.StrEscape;
          break;
        case S.StrEscape:
          this.state = b === 0x5c ? S.Text : S.Str;
          break;
      }
    }
    if (this.peak <= this.reportedPeak) return null;
    this.reportedPeak = this.peak;
    return this.peak;
  }

  /** True between ESC[?1049h (or ?47h, ?1047h) and the matching reset. */
  get isAlternateScreen(): boolean {
    return this.altScreen;
  }

  /** The widest line measured (0 after Clear or Restart). */
  get longest(): number {
    return this.peak;
  }

  /** Clear Shell: the peak goes; the alt-screen latch stays (clearing doesn't quit the program). */
  clearScrollback() {
    this.peak = 0;
    this.reportedPeak = 0;
    this.column = 0;
    this.lineHighWater = 0;
  }

  /** A new shell: everything, the latch included. */
  reset() {
    this.clearScrollback();
    this.state = S.Text;
    this.altScreen = false;
    this.params = [];
    this.paramValue = 0;
    this.paramHasDigits = false;
    this.csiPrivate = false;
  }

  private endLine() {
    if (!this.altScreen && this.lineHighWater > this.peak) this.peak = Math.min(this.lineHighWater, MAX_MEASURED_COLUMNS);
    this.column = 0;
    this.lineHighWater = 0;
  }

  private noteColumn() {
    if (this.column > this.lineHighWater) this.lineHighWater = this.column;
  }

  private text(b: number) {
    if (b === 0x1b) this.state = S.Escape;
    else if (b === 0x0a || b === 0x0b || b === 0x0c || b === 0x0d) this.endLine();
    else if (b === 0x08) this.column = Math.max(0, this.column - 1);
    else if (b === 0x09) {
      this.column = (Math.floor(this.column / 8) + 1) * 8;
      this.noteColumn();
    } else if (b <= 0x1f || b === 0x7f) {
      // Other C0 controls paint nothing.
    } else if ((b & 0xc0) !== 0x80) {
      // One column per UTF-8 lead byte. Double-width glyphs count as one (0.90.34's known
      // limitation: the meter under-counts, never over-counts).
      this.column += 1;
      this.noteColumn();
    }
  }

  private escape(b: number) {
    if (b === 0x5b) {
      this.state = S.Csi;
      this.params = [];
      this.paramValue = 0;
      this.paramHasDigits = false;
      this.csiPrivate = false;
    } else if (b === 0x5d || b === 0x50 || b === 0x58 || b === 0x5e || b === 0x5f) {
      this.state = S.Str;
    } else {
      // A two-character escape (ESC 7, ESC =, ESC M…), consumed whole.
      this.state = S.Text;
    }
  }

  private csi(b: number) {
    if (b >= 0x30 && b <= 0x39) {
      this.paramValue = this.paramValue * 10 + (b - 0x30);
      this.paramHasDigits = true;
    } else if (b === 0x3b) {
      this.pushParam();
    } else if (b >= 0x3c && b <= 0x3f) {
      if (b === 0x3f) this.csiPrivate = true;
    } else if (b >= 0x20 && b <= 0x2f) {
      // Intermediate bytes.
    } else if (b >= 0x40 && b <= 0x7e) {
      this.pushParam();
      this.applyCsi(b);
      this.state = S.Text;
    } else {
      // A C0 byte inside a sequence aborts it.
      this.state = S.Text;
      this.text(b);
    }
  }

  private pushParam() {
    if (this.paramHasDigits && this.params.length < 8) this.params.push(this.paramValue);
    this.paramValue = 0;
    this.paramHasDigits = false;
  }

  private applyCsi(final: number) {
    if (this.csiPrivate && (final === 0x68 || final === 0x6c)) {
      for (const mode of this.params) if (mode === 47 || mode === 1047 || mode === 1049) this.altScreen = final === 0x68;
      return;
    }
    if (final === 0x4b) {
      const p = this.params[0] ?? 0;
      if (p === 0) this.lineHighWater = Math.min(this.lineHighWater, this.column);
      else if (p === 2) this.lineHighWater = 0;
      return;
    }
    // Cursor motion ends the line being measured: A B C D E F G H ` d f.
    if ([0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x60, 0x64, 0x66].includes(final)) this.endLine();
  }
}

/** The terminal's minimum width for a measured line: characters × cell width + 40 (`recomputeMinTerminalWidth`). */
export function minTerminalWidth(longestChars: number, cellWidth: number): number {
  return longestChars > 0 ? longestChars * cellWidth + 40 : 0;
}
