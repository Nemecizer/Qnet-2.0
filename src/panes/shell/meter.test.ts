// The line-width meter against shell.md §15's width cases (ledger SH-053, SH-054, INV-059).
import { describe, expect, it } from "vitest";
import { LineWidthMeter, MAX_MEASURED_COLUMNS, minTerminalWidth } from "./meter";

const enc = new TextEncoder();
function measure(...chunks: string[]): { meter: LineWidthMeter; reports: (number | null)[] } {
  const meter = new LineWidthMeter();
  const reports = chunks.map((c) => meter.scan(enc.encode(c)));
  return { meter, reports };
}

describe("the line-width meter (shell.md §4)", () => {
  it("printf 'abcd\\b\\b' still measures 4 columns: backspace paints and erases nothing", () => {
    expect(measure("abcd\b\b\n").meter.longest).toBe(4);
  });

  it("does not count a shell-integration prompt's OSC 7 path as printed columns (BEL or ST)", () => {
    const path = "file://host/Users/someone/a/very/long/folder/name/that/goes/on/and/on/for/many/columns";
    expect(measure(`\x1b]7;${path}\x07% \r\n`).meter.longest).toBe(2);
    expect(measure(`\x1b]7;${path}\x1b\\ab\r\n`).meter.longest).toBe(2);
    // Other string sequences too: DCS, PM, APC, and a window title.
    expect(measure(`\x1bPq${"x".repeat(80)}\x1b\\\x1b^${"y".repeat(80)}\x1b\\\x1b_${"z".repeat(80)}\x1b\\\x1b]0;${"t".repeat(90)}\x07ok\n`).meter.longest).toBe(2);
  });

  it("ESC[2K on the widest line lets it go, ESC[K narrows it to the cursor, ESC[1K does not", () => {
    expect(measure(`${"w".repeat(200)}\x1b[2K\rshort\n`).meter.longest).toBe(5);
    expect(measure(`${"w".repeat(100)}\x1b[60D\x1b[K\n`).meter.longest).toBe(100);
    // \x1b[60D is cursor motion: it ended the 100-wide line before the erase.
    expect(measure(`${"w".repeat(100)}\b\b\b\b\x1b[K\n`).meter.longest).toBe(96);
    expect(measure(`${"w".repeat(100)}\b\b\b\b\x1b[0K\n`).meter.longest).toBe(96);
    expect(measure(`${"w".repeat(100)}\b\b\b\b\x1b[1K\n`).meter.longest).toBe(100);
  });

  it("ignores everything a full-screen program paints on the alternate screen", () => {
    for (const mode of ["1049", "47", "1047"]) {
      const { meter } = measure(`\x1b[?${mode}h${"v".repeat(200)}\r\n${"v".repeat(150)}\n`);
      expect(meter.isAlternateScreen).toBe(true);
      expect(meter.longest).toBe(0);
      meter.scan(enc.encode(`\x1b[?${mode}lback\n`));
      expect(meter.isAlternateScreen).toBe(false);
      expect(meter.longest).toBe(4);
    }
  });

  it("a 200-column table measures 200 and reports only when the peak grows", () => {
    const row = "x".repeat(200);
    const { reports, meter } = measure(`${row}\r\n`, "short\r\n", `${row}\r\n`, `${"y".repeat(201)}\n`);
    expect(reports).toEqual([200, null, null, 201]);
    expect(meter.longest).toBe(201);
  });

  it("caps a line at 240 columns, counts tab stops of 8 and one column per UTF-8 character", () => {
    expect(measure(`${"r".repeat(5000)}\n`).meter.longest).toBe(MAX_MEASURED_COLUMNS);
    expect(measure("ab\tc\n").meter.longest).toBe(9);
    expect(measure("ρ = 0.984 ± 0.001 — ok\n").meter.longest).toBe(22);
    // Split inside a multi-byte character and inside an escape sequence, as reads arrive.
    const m = new LineWidthMeter();
    const b = enc.encode("±±\x1b[31mred\x1b[0m\n");
    for (const part of [b.slice(0, 1), b.slice(1, 5), b.slice(5, 8), b.slice(8)]) m.scan(part);
    expect(m.longest).toBe(5);
  });

  it("cursor motion ends a line; SGR does not; a C0 byte aborts a sequence", () => {
    expect(measure(`${"a".repeat(30)}\x1b[5;1H${"b".repeat(20)}\n`).meter.longest).toBe(30);
    expect(measure(`\x1b[1;31m${"c".repeat(30)}\x1b[0m\n`).meter.longest).toBe(30);
    expect(measure(`\x1b[3\nabc\n`).meter.longest).toBe(3);
  });

  it("progress bars that redraw over themselves with CR measure their widest frame", () => {
    expect(measure("Running ...  [   ]\r\x1b[KRunning ...  [\x1b[7m \x1b[27m ]  1/8\n").meter.longest).toBe(22);
  });

  it("Clear forgets the peak but keeps the alt-screen latch; a new shell resets both", () => {
    const { meter } = measure(`${"w".repeat(120)}\n\x1b[?1049h`);
    meter.clearScrollback();
    expect(meter.longest).toBe(0);
    expect(meter.isAlternateScreen).toBe(true);
    expect(meter.scan(enc.encode("x".repeat(10)))).toBeNull();
    meter.reset();
    expect(meter.isAlternateScreen).toBe(false);
  });

  it("turns characters into a width: × the cell width + 40, nothing when nothing was measured", () => {
    expect(minTerminalWidth(200, 7)).toBe(1440);
    expect(minTerminalWidth(0, 7)).toBe(0);
  });
});
