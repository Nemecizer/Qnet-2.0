// The Shell pane against the preview's echo shell (src/dev/mock/shell.ts) and 0.90.34's replayed
// runs (src/dev/mock/runs.ts): xterm.js runs in jsdom with its DOM renderer (no canvas).
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DialogHost } from "../../components/DialogHost";
import { defaultHandlers } from "../../dev/mockBackend";
import { mockRuns } from "../../dev/mock/runs";
import { MOCK_PROMPT, mockShell, shellHandlers } from "../../dev/mock/shell";
import { editCommands } from "../../editor/commands";
import { getCommand, registerCommands, runCommand } from "../../lib/commands";
import { getSetting } from "../../lib/kv";
import { onRunFinished, startRun } from "../../runs/state";
import { mockTauri } from "../../test/tauri";
import { handlersFor } from "../../workspace/focus";
import { addTab, tabById } from "../../workspace/store";
import { copyShellSelection, pasteIntoShell, saveShellTranscript, selectAllInShell, shellHasSelection } from "./commands";
import { copyFromShell, HEADER_CONDENSE_WIDTH, ShellPane } from "./ShellPane";
import { fromBase64, MAX_CAPTURED, RESET_CODES, SAVE_INTERVAL_MS, toBase64 } from "./transcript";
import { existingShellView, LEADING_INSET, resetShellView, shellView, type ShellView } from "./view";
import { shellWords as w } from "./words";
import "./index";

HTMLCanvasElement.prototype.getContext = (() => null) as never;

const examples = import.meta.glob("../../../examples/*.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const display = import.meta.glob("../../../golden/runs/5stationtandem.inf/qna/display.txt", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

function openExample(stem: string): string {
  return addTab({ title: `${stem}.bnet`, path: `/examples/${stem}.bnet`, document: JSON.parse(examples[`../../../examples/${stem}.bnet`]) });
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Every row of the normal buffer, trimmed. */
function rows(v: ShellView): string[] {
  const b = v.term.buffer.normal;
  const out: string[] = [];
  for (let y = 0; y < b.length; y++) out.push(b.getLine(y)!.translateToString(true).trimEnd());
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}
const cursorRow = (v: ShellView) => v.term.buffer.active.getLine(v.term.buffer.active.baseY + v.term.buffer.active.cursorY)!.translateToString(true).trimEnd();

async function settle(v: ShellView) {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await tick();
      await v.drained();
    });
  }
}

/** Renders the pane and waits for the echo shell's first prompt. */
async function showShell(): Promise<ShellView> {
  render(
    <>
      <ShellPane />
      <DialogHost />
    </>,
  );
  const v = existingShellView()!;
  await waitFor(() => expect(mockShell.starts.length).toBeGreaterThan(0));
  await settle(v);
  return v;
}

function sizePane(v: ShellView, width: number, height = 300) {
  Object.defineProperty(v.root, "clientWidth", { configurable: true, get: () => width });
  Object.defineProperty(v.root, "clientHeight", { configurable: true, get: () => height });
  v.layout();
}

beforeEach(() => {
  mockTauri(defaultHandlers());
  mockRuns.replayMs = 5;
});
afterEach(() => {
  resetShellView();
  vi.useRealTimers();
});

describe("the shell process and its lifetime (SH-001…012, INV-008, WS-056)", () => {
  it("starts the login shell the first time the pane is shown and talks to it", async () => {
    expect(existingShellView()).toBeNull();
    const v = await showShell();
    expect(mockShell.starts).toHaveLength(1);
    expect(cursorRow(v)).toBe("%");
    // xterm with a blinking block cursor, 5,000 lines of scrollback, Option as Meta (SH-015, SH-016).
    expect(v.term.options).toMatchObject({ scrollback: 5000, cursorStyle: "block", cursorBlink: true, macOptionIsMeta: true });
    // VoiceOver: the input is "Shell" with 0.90.34's help; the view a group "Shell pane" (SH-017).
    expect(v.term.textarea).toHaveAttribute("aria-label", w.terminalLabel);
    expect(v.term.textarea).toHaveAttribute("aria-description", "Interactive shell. Solver runs print their output here.");
    expect(screen.getByRole("group", { name: "Shell pane" })).toBe(v.root);
    expect(v.scroller).toHaveAttribute("aria-label", "Shell horizontal scroll bar");
    // Nothing is dropped onto the terminal (SH-022).
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    v.term.textarea!.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    // Window titles are ignored (SH-023).
    mockShell.send("\x1b]0;a title\x07\x1b]2;another\x07");
    await settle(v);
    expect(cursorRow(v)).toBe("%");
    act(() => v.term.input("ls"));
    await settle(v);
    expect(mockShell.inputs.join("")).toBe("ls");
    expect(cursorRow(v)).toBe("% ls");
    // Resizing the terminal tells the PTY (TIOCSWINSZ).
    act(() => v.term.resize(100, 20));
    await waitFor(() => expect(mockShell.sizes.at(-1)).toEqual([100, 20]));
  });

  it("keeps the same terminal, shell and scrollback when the pane is remounted (hide, maximize, detach)", async () => {
    const v = await showShell();
    mockShell.send("\r\nsaved line\r\n" + MOCK_PROMPT);
    await settle(v);
    const term = v.term;
    const { unmount } = { unmount: () => screen.getByRole("region", { name: w.title }) };
    void unmount;
    // Unmount every pane tree and mount a fresh one in another container (a detached window's body).
    const other = document.createElement("div");
    document.body.appendChild(other);
    render(<ShellPane />, { container: other });
    await settle(v);
    expect(existingShellView()).toBe(v);
    expect(v.term).toBe(term);
    expect(other.contains(v.root)).toBe(true);
    expect(mockShell.starts).toHaveLength(1);
    expect(rows(v)).toContain("saved line");
  });

  it("follows cd through OSC 7 in the header, and shows the exited state with a Restart that doesn't ask", async () => {
    const v = await showShell();
    await waitFor(() => expect(screen.getByTitle(w.directoryHelp("/Users/preview/models"))).toBeInTheDocument());
    mockShell.send("\x1b]7;file://host/Users/preview/My%20Models\x07");
    await settle(v);
    expect(v.snapshot().cwd).toBe("/Users/preview/My Models");
    mockShell.send("\x1b]7;/tmp/bare%20path\x1b\\");
    await settle(v);
    expect(v.snapshot().cwd).toBe("/tmp/bare path");
    expect(screen.getByRole("img", { name: w.running })).toBeInTheDocument();
    act(() => mockShell.exit(0));
    await waitFor(() => expect(screen.getByRole("img", { name: w.exited })).toBeInTheDocument());
    // Typing into an exited shell goes nowhere.
    act(() => v.term.input("x"));
    expect(mockShell.inputs).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: w.restartNowLabel }));
    await waitFor(() => expect(mockShell.starts).toHaveLength(2));
    expect(mockShell.stops).toBe(1);
    await waitFor(() => expect(screen.getByRole("img", { name: w.running })).toBeInTheDocument());
  });

  it("Restart Shell… asks in 0.90.34's words, then forgets the transcript and starts a new shell in an empty terminal", async () => {
    mockTauri({ ...defaultHandlers(), ...shellHandlers({ transcript: toBase64(enc.encode("old session\r\n")) }) });
    const v = await showShell();
    expect(rows(v)).toContain("old session");
    sizePane(v, 400);
    mockShell.send(`${"w".repeat(200)}\r\n${MOCK_PROMPT}`);
    await settle(v);
    expect(v.meter.longest).toBe(202);
    act(() => void runCommand("shell:restart"));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(w.restartTitle);
    expect(dialog).toHaveTextContent(w.restartMessage);
    fireEvent.click(within(dialog).getByRole("button", { name: w.restartConfirm }));
    await waitFor(() => expect(mockShell.starts).toHaveLength(2));
    await settle(v);
    expect(mockShell.transcript).toBeNull();
    expect(mockShell.stops).toBe(1);
    expect(rows(v)).toEqual(["%"]);
    expect(v.meter.longest).toBe(0);
    expect(v.snapshot().overflow).toBe(false);
  });

  it("Cancel leaves the shell and its transcript alone", async () => {
    mockTauri({ ...defaultHandlers(), ...shellHandlers({ transcript: toBase64(enc.encode("keep me\r\n")) }) });
    await showShell();
    act(() => void runCommand("shell:restart"));
    await screen.findByRole("alertdialog");
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await tick();
    expect(mockShell.stops).toBe(0);
    expect(mockShell.transcript).not.toBeNull();
  });
});

describe("Clear Shell and Window ▸ Shell (SH-035, MENU-154…156)", () => {
  it("registers Clear Shell, Find in Shell… and Restart Shell… with 0.90.34's help", () => {
    expect(getCommand("shell:clear")).toMatchObject({ title: w.menuClear, subtitle: w.menuClearHelp });
    expect(getCommand("shell:find")).toMatchObject({ title: w.menuFind, subtitle: w.menuFindHelp });
    expect(getCommand("shell:restart")).toMatchObject({ title: w.menuRestart, subtitle: w.menuRestartHelp });
  });

  it("erases screen and scrollback, sends ⌃L for a fresh prompt, and forgets the capture and the width", async () => {
    const v = await showShell();
    sizePane(v, 300);
    mockShell.send(`\r\n${"t".repeat(150)}\r\n` + "line\r\n".repeat(80) + MOCK_PROMPT);
    await settle(v);
    expect(v.snapshot().overflow).toBe(true);
    expect(v.snapshot().canScroll).toBe(true);
    act(() => void runCommand("shell:clear"));
    await settle(v);
    expect(mockShell.inputs).toContain("\x0c");
    expect(rows(v)).toEqual(["%"]);
    expect(v.term.buffer.active.baseY).toBe(0);
    expect(v.meter.longest).toBe(0);
    expect(v.snapshot().overflow).toBe(false);
    expect(v.snapshot().canScroll).toBe(false);
    // The capture holds only what came after the clear: the redrawn prompt.
    expect(dec.decode(v.capture.bytes())).toBe(`\x1b[H\x1b[2J${MOCK_PROMPT}`);
    expect(mockShell.alive).toBe(true);
  });

  it("Find in Shell… reveals the pane and opens the find bar", async () => {
    const v = await showShell();
    await act(async () => {
      await runCommand("shell:find");
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(v.snapshot().findOpen).toBe(true);
    expect(screen.getByRole("searchbox", { name: w.findField })).toHaveFocus();
  });
});

describe("the transcript (SH-025…034, SET-187, WS-131, INV-024, INV-060)", () => {
  it("replays the last session pre-sized to 120 columns, resets its modes, and puts the cursor on a fresh bottom line under a dated separator", async () => {
    const wide = "x".repeat(110);
    const saved = `\x1b[31mred text\x1b[0m\r\n${wide}\r\n\x1b[?2004h\x1b[?25l\x1b[?1049hvim screen`;
    mockTauri({ ...defaultHandlers(), ...shellHandlers({ transcript: toBase64(enc.encode(saved)) }) });
    let launched: Date | null = null;
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function () {
      return { format: (d: Date) => ((launched = d), "11/11/26, 6:05 PM") };
    } as never);
    const v = await showShell();
    expect(launched).not.toBeNull();
    const r = rows(v);
    // Not a 2-column stripe: the 110-column line is one row.
    expect(r).toContain(wide);
    expect(r).toContain("red text");
    // The colour survived: the replayed cell is red (palette 1).
    const line = v.term.buffer.normal.getLine(r.indexOf("red text"))!;
    expect(line.getCell(0)!.getFgColor()).toBe(1);
    // Force-killed inside vim: back on the normal screen, bracketed paste off, cursor shown.
    expect(v.term.buffer.active.type).toBe("normal");
    expect(v.term.modes.bracketedPasteMode).toBe(false);
    const sep = r.findIndex((l) => l.includes("previous session above"));
    expect(r[sep]).toBe("──── previous session above — new session 11/11/26, 6:05 PM ────");
    expect(r[sep - 1]).toBe("");
    expect(r[sep + 1]).toBe("");
    // The shell's first prompt comes after it, on its own line.
    expect(r.at(-1)).toBe("%");
    // The capture is seeded with the replay, so a quit at once carries the history forward.
    const captured = dec.decode(v.capture.bytes());
    expect(captured.startsWith(saved + RESET_CODES)).toBe(true);
    expect(v.meter.longest).toBe(110);
  });

  it("saves every 10 s and at quit (forced), and never overwrites the last session with nothing", async () => {
    mockTauri({ ...defaultHandlers(), ...shellHandlers({ transcript: toBase64(enc.encode("previous\r\n")) }) });
    // A launch whose Shell was never shown leaves the transcript alone.
    await saveShellTranscript();
    expect(mockShell.saves).toEqual([]);
    const intervals: [() => void, number][] = [];
    const real = window.setInterval;
    vi.spyOn(window, "setInterval").mockImplementation(((fn: () => void, ms: number) => (intervals.push([fn, ms]), real(() => {}, 1e9))) as never);
    const v = await showShell();
    const backstop = intervals.find(([, ms]) => ms === SAVE_INTERVAL_MS)!;
    expect(backstop).toBeDefined();
    await act(async () => {
      backstop[0]();
      await tick();
    });
    expect(mockShell.saves).toHaveLength(1);
    expect(dec.decode(fromBase64(mockShell.saves[0]))).toContain("previous");
    // Nothing new: the backstop doesn't write again; the quit save always does.
    await act(async () => {
      backstop[0]();
      await tick();
    });
    expect(mockShell.saves).toHaveLength(1);
    mockShell.send("last words\r\n");
    await saveShellTranscript();
    expect(mockShell.saves).toHaveLength(2);
    expect(dec.decode(fromBase64(mockShell.saves[1]))).toMatch(/last words\r\n$/);
    void v;
  });

  it("keeps at most the last 1 MiB", async () => {
    const v = await showShell();
    mockShell.send("a".repeat(MAX_CAPTURED) + "z".repeat(1000));
    await settle(v);
    const b = v.capture.bytes();
    expect(b.length).toBe(MAX_CAPTURED);
    expect(dec.decode(b.slice(-1000))).toBe("z".repeat(1000));
  });
});

describe("width and scrolling (SH-052…061, INV-059)", () => {
  it("a 200-column table widens the terminal past the pane instead of wrapping; full-screen programs get the pane's width", async () => {
    const v = await showShell();
    sizePane(v, 400 + LEADING_INSET);
    const cell = v.cellSize();
    expect(v.term.cols).toBe(Math.floor(400 / cell.width));
    const table = "|" + "-".repeat(198) + "|";
    mockShell.send(`\r\n${table}\r\n${MOCK_PROMPT}`);
    await settle(v);
    expect(v.meter.longest).toBe(200);
    expect(v.snapshot().overflow).toBe(true);
    expect(v.term.cols).toBeGreaterThanOrEqual(200);
    expect(v.host.style.width).toBe(`${200 * cell.width + 40}px`);
    expect(rows(v)).toContain(table);
    // Widening the pane doesn't lengthen what was measured (no layout loop).
    sizePane(v, 3000);
    expect(v.meter.longest).toBe(200);
    expect(v.snapshot().overflow).toBe(false);
    sizePane(v, 400 + LEADING_INSET);
    // vim takes the alternate screen: the pane's own width, no scroller.
    mockShell.send("\x1b[?1049h" + "v".repeat(300));
    await settle(v);
    expect(v.term.buffer.active.type).toBe("alternate");
    expect(v.term.cols).toBe(Math.floor(400 / cell.width));
    expect(v.snapshot().overflow).toBe(false);
    expect(v.meter.longest).toBe(200);
    mockShell.send("\x1b[?1049l");
    await settle(v);
    expect(v.term.cols).toBeGreaterThanOrEqual(200);
  });

  it("the font size changes the width in pixels, so a smaller font can retract the scroller", async () => {
    const v = await showShell();
    sizePane(v, 1000);
    mockShell.send(`\r\n${"q".repeat(130)}\r\n`);
    await settle(v);
    const before = v.host.style.width;
    act(() => v.applySettings({ fontSize: 20, fontName: "", classic: false }));
    expect(v.host.style.width).not.toBe(before);
    expect(v.term.options.fontSize).toBe(20);
  });

  it("pans sideways on a mostly-horizontal wheel only when there is something to pan", async () => {
    const v = await showShell();
    sizePane(v, 300);
    const e1 = new WheelEvent("wheel", { deltaX: 50, deltaY: 2, bubbles: true, cancelable: true });
    v.root.dispatchEvent(e1);
    expect(e1.defaultPrevented).toBe(false);
    mockShell.send(`${"p".repeat(200)}\r\n`);
    await settle(v);
    const e2 = new WheelEvent("wheel", { deltaX: 50, deltaY: 2, bubbles: true, cancelable: true });
    v.root.dispatchEvent(e2);
    expect(e2.defaultPrevented).toBe(true);
    const e3 = new WheelEvent("wheel", { deltaX: 2, deltaY: 50, bubbles: true, cancelable: true });
    v.root.dispatchEvent(e3);
    expect(e3.defaultPrevented).toBe(false);
  });

  it("insets the terminal 6 px from the left and 10 px from the bottom; Scroll to Bottom goes to the prompt", async () => {
    const v = await showShell();
    sizePane(v, 500, 200);
    const cell = v.cellSize();
    expect(v.lastLayout.usable).toBe(494);
    expect(v.term.rows).toBe(Math.floor(190 / cell.height));
    mockShell.send("x\r\n".repeat(100) + MOCK_PROMPT);
    await settle(v);
    act(() => v.term.scrollToTop());
    expect(v.term.buffer.active.viewportY).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: w.scrollToBottom }));
    expect(v.term.buffer.active.viewportY).toBe(v.term.buffer.active.baseY);
    expect(screen.getByRole("button", { name: w.scrollToBottom })).toHaveAttribute("title", w.scrollToBottomHelp);
    expect(v.vbar.getAttribute("aria-label")).toBe(w.vScrollLabel);
    expect(v.vbar.dataset.enabled).toBe("true");
  });
});

describe("runs in the Shell (D1, SH-072…078, SH-088…091)", () => {
  it("writes a run's output into the view above the prompt, keeps a half-typed command, and never types into the shell", async () => {
    const id = openExample("5stationtandem.inf");
    const v = await showShell();
    mockShell.send("\r\nmy own output\r\n" + MOCK_PROMPT);
    act(() => v.term.input("ls -l"));
    await settle(v);
    expect(cursorRow(v)).toBe("% ls -l");
    const done = new Promise<void>((r) => {
      const stop = onRunFinished(() => (stop(), r()));
    });
    await act(async () => {
      expect(await startRun(id, "qna")).toBe(true);
      await done;
    });
    await settle(v);
    const r = rows(v);
    // The user's output above the block is untouched (0.90.34's ESC[A ESC[2K is not replayed).
    expect(r).toContain("my own output");
    const golden = Object.values(display)[0].replace("\x1b[A\x1b[2K", "");
    const firstLine = golden.split("\n")[0];
    expect(r).toContain(firstLine);
    expect(r).toContain("Elapsed time: " + /Elapsed time: (\S+)/.exec(golden)![1]);
    // The prompt and the half-typed command are back on the last line, the cursor after them.
    expect(r.at(-1)).toBe("% ls -l");
    expect(cursorRow(v)).toBe("% ls -l");
    expect(v.term.buffer.active.cursorX).toBe(7);
    // Exactly one prompt line with the command: the block didn't duplicate it.
    expect(r.filter((l) => l === "% ls -l")).toHaveLength(1);
    // Nothing of the run went to the shell.
    expect(mockShell.inputs.join("")).toBe("ls -l");
    // The shell keeps working after it: typing continues the same line.
    act(() => v.term.input("a\r"));
    await settle(v);
    expect(rows(v)).toContain("% ls -la");
    expect(tabById(id)!.log.map((l) => l.text)).toContain("Running QNA...");
  });

  it("animates a progress line in place above the prompt, and continues it below output the user ran meanwhile", async () => {
    const v = await showShell();
    const meta = { tabId: "T", method: "sim" };
    const frame = (k: number) => `\r\x1b[KRunning simulation ...  [${"\x1b[7m \x1b[27m ".repeat(k)}]  ${k}/4`;
    act(() => v.runOutput(enc.encode("\x1b[A\x1b[2K[Threads] 4 cores\nRunning simulation ...  [ ]  starting ..."), meta));
    await settle(v);
    for (let k = 1; k <= 3; k++) act(() => v.runOutput(enc.encode(frame(k)), meta));
    await settle(v);
    let r = rows(v);
    expect(r.filter((l) => l.startsWith("Running simulation"))).toEqual([`Running simulation ...  [${"   ".repeat(0)}${"  ".repeat(3)}]  3/4`]);
    expect(r.at(-1)).toBe("%");
    expect(r.at(-2)).toMatch(/3\/4$/);
    // The bar is drawn in reverse video.
    const barRow = v.term.buffer.normal.getLine(r.length - 2)!;
    expect(barRow.getCell(25)!.isInverse()).toBeTruthy();
    // The user runs something mid-run: it lands below the bar; the bar carries on below it.
    act(() => v.term.input("pwd\r"));
    await settle(v);
    act(() => v.runOutput(enc.encode(frame(4) + "\n\nE[X_1]  13.962\n\nElapsed time: 0.083s\n\n"), meta));
    act(() => v.endRun());
    await settle(v);
    r = rows(v);
    expect(r).toContain("pwd");
    expect(r.indexOf("pwd")).toBeLessThan(r.findIndex((l) => l.endsWith("4/4")));
    expect(r).toContain("E[X_1]  13.962");
    expect(r).toContain("Elapsed time: 0.083s");
    expect(r.at(-1)).toBe("%");
    expect(r.filter((l) => l === "%")).toHaveLength(1);
  });

  it("holds run output while a full-screen program owns the screen, and writes it when the program leaves", async () => {
    const v = await showShell();
    mockShell.send("\x1b[?1049hVIM SCREEN");
    await settle(v);
    act(() => v.runOutput(enc.encode("QNA table\n"), { tabId: "T", method: "qna" }));
    await settle(v);
    expect(v.term.buffer.alternate.getLine(0)!.translateToString(true).trim()).toBe("VIM SCREEN");
    expect(rows(v)).not.toContain("QNA table");
    mockShell.send("\x1b[?1049l");
    await settle(v);
    expect(rows(v)).toContain("QNA table");
    expect(rows(v).at(-1)).toBe("%");
  });

  it("measures and captures run output too, so wide tables scroll and replay", async () => {
    const v = await showShell();
    sizePane(v, 300);
    act(() => v.runOutput(enc.encode(`${"r".repeat(180)}\nElapsed time: 0.1s\n\n`), { tabId: "T", method: "cmp" }));
    await settle(v);
    expect(v.meter.longest).toBe(180);
    expect(v.snapshot().overflow).toBe(true);
    expect(dec.decode(v.capture.bytes())).toContain("Elapsed time: 0.1s");
    expect(rows(v)).toContain("r".repeat(180));
  });
});

describe("copy, paste, selection, find, the context menu (SH-038…051, INV-062, MENU-046)", () => {
  let clip: string[];
  beforeEach(() => {
    clip = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void clip.push(t), readText: async () => "pasted" } });
  });

  it("⌘C copies the selection or nothing — never the scrollback, and never an empty string over the clipboard", async () => {
    const v = await showShell();
    mockShell.send("\r\nhello world\r\n");
    await settle(v);
    expect(shellHasSelection()).toBe(false);
    expect(await copyShellSelection()).toBe(false);
    expect(clip).toEqual([]);
    // The browser's own copy event on xterm's input copies nothing either.
    const set = vi.fn();
    const ev = new Event("copy", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(ev, "clipboardData", { value: { setData: set } });
    v.term.textarea!.dispatchEvent(ev);
    expect(set).not.toHaveBeenCalled();
    const row = rows(v).indexOf("hello world");
    act(() => v.term.select(0, row, 5));
    expect(shellHasSelection()).toBe(true);
    expect(await copyShellSelection()).toBe(true);
    expect(clip).toEqual(["hello"]);
    act(() => selectAllInShell());
    expect(v.term.getSelection()).toContain("hello world");
  });

  it("the header's Copy falls back to the whole scrollback and says which it was", async () => {
    const empty = shellView();
    expect(await copyFromShell(empty)).toBe(false);
    resetShellView();
    const tab = addTab({ title: "t.bnet" });
    void tab;
    const v = await showShell();
    mockShell.send("\r\nline one\r\nline two\r\n");
    await settle(v);
    fireEvent.click(screen.getByRole("button", { name: w.copy }));
    await waitFor(() => expect(clip).toHaveLength(1));
    expect(clip[0]).toContain("line one\nline two");
    await screen.findByRole("button", { name: w.copied });
    const row = rows(v).indexOf("line two");
    act(() => v.term.select(0, row, 4));
    await act(async () => void (await copyFromShell(v)));
    expect(clip[1]).toBe("line");
  });

  it("logs what Copy did in 0.90.34's words", async () => {
    const tabId = addTab({ title: "t.bnet" });
    const empty = shellView();
    const box = document.createElement("div");
    document.body.appendChild(box);
    empty.attach(box);
    await copyFromShell(empty);
    const log = () => tabById(tabId)!.log.map((l) => [l.text, l.severity]);
    expect(log().at(-1)).toEqual([w.nothingToCopy, "warning"]);
    empty.term.write("abc\r\nd");
    await empty.drained();
    await copyFromShell(empty);
    expect(log().at(-1)).toEqual(["Copied 5 characters — the whole shell scrollback (nothing was selected).", "success"]);
    empty.term.select(0, 0, 2);
    await copyFromShell(empty);
    expect(log().at(-1)).toEqual(["Copied 2 characters from the shell selection.", "success"]);
    expect(w.copiedSelection(12345)).toBe("Copied 12,345 characters from the shell selection.");
  });

  it("paste goes to the shell as a paste, bracketed when the program asked for it", async () => {
    const v = await showShell();
    await act(async () => void (await pasteIntoShell()));
    expect(mockShell.inputs.at(-1)).toBe("pasted");
    mockShell.send("\x1b[?2004h");
    await settle(v);
    await act(async () => void (await pasteIntoShell("x y")));
    expect(mockShell.inputs.at(-1)).toBe("\x1b[200~x y\x1b[201~");
  });

  it("⌘F is Find in Shell…: it searches the scrollback; ⌘G steps without taking focus", async () => {
    const v = await showShell();
    mockShell.send("\r\nalpha beta\r\ngamma beta\r\n" + MOCK_PROMPT);
    await settle(v);
    const h = handlersFor("shell")!;
    expect(h.findTitle).toBe("Find in Shell…");
    // Window ▸ Focus Shell's handler puts the keyboard in the terminal (SH-068).
    act(() => h.focus!());
    expect(document.activeElement).toBe(v.term.textarea);
    expect(h.canStepFind!()).toBe(false);
    act(() => h.find!());
    const field = screen.getByRole("searchbox", { name: w.findField });
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: "beta" } });
    expect(v.term.getSelection()).toBe("beta");
    expect(h.canStepFind!()).toBe(true);
    const first = v.term.getSelectionPosition()!.start.y;
    act(() => h.stepFind!(1));
    expect(v.term.getSelectionPosition()!.start.y).not.toBe(first);
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: "zzz" } });
    expect(screen.getByText(w.noMatches)).toBeInTheDocument();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(v.snapshot().findOpen).toBe(false);
  });

  it("text size steps 1 pt within 8–28 through the zoom handler, the header and Settings' key", async () => {
    const v = await showShell();
    const h = handlersFor("shell")!;
    await act(async () => h.zoom!(1));
    expect(getSetting("shell.fontSize", 0)).toBe(13);
    await waitFor(() => expect(v.term.options.fontSize).toBe(13));
    fireEvent.click(screen.getByRole("button", { name: w.smaller }));
    await waitFor(() => expect(getSetting("shell.fontSize", 0)).toBe(12));
    expect(h.canZoom!(1)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: `${w.fontMenuHelp}: ${w.systemMono}` }));
    fireEvent.click(within(screen.getByRole("menu", { name: w.shellFont })).getByText("Menlo"));
    await waitFor(() => expect(v.term.options.fontFamily).toMatch(/^"Menlo", /));
    await waitFor(() => expect(screen.getByRole("button", { name: `${w.fontMenuHelp}: Menlo` })).toBeInTheDocument());
  });

  it("folds the font family and size into one \"More Shell controls\" menu below 560 pt", async () => {
    expect(HEADER_CONDENSE_WIDTH).toBe(560);
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")!;
    Object.defineProperty(Element.prototype, "clientWidth", {
      configurable: true,
      get(this: Element) {
        return this.classList.contains("pane-shell") ? 400 : desc.get!.call(this);
      },
    });
    try {
      await showShell();
      const more = await screen.findByRole("button", { name: w.more });
      expect(more).toHaveAttribute("title", w.moreHelp);
      expect(screen.queryByRole("button", { name: w.bigger })).toBeNull();
      fireEvent.click(more);
      const menu = screen.getByRole("menu", { name: w.more });
      expect([...menu.querySelectorAll(".ctx-label")].map((e) => e.textContent).slice(0, 3)).toEqual([w.bigger, w.smaller, w.systemMono]);
    } finally {
      Object.defineProperty(Element.prototype, "clientWidth", desc);
    }
  });

  it("the right-click menu has 0.90.34's items and enablement, and none at all under mouse reporting", async () => {
    const v = await showShell();
    fireEvent.contextMenu(v.root, { clientX: 20, clientY: 20 });
    const menu = screen.getByRole("menu", { name: w.title });
    const items = [...menu.querySelectorAll(".ctx-item")].map((e) => [e.querySelector(".ctx-label")!.textContent, e.querySelector(".ctx-shortcut")?.textContent ?? "", e.getAttribute("aria-disabled") === "true"]);
    expect(items).toEqual([
      ["Copy", "⌘C", true],
      ["Paste", "⌘V", false],
      ["Select All", "⌘A", false],
      ["Find in Shell…", "⌘F", false],
      ["Scroll to Bottom", "", true],
      ["Clear Shell", "⌘K", false],
    ]);
    fireEvent.keyDown(menu, { key: "Escape" });
    mockShell.send("\x1b[?1000h");
    await settle(v);
    fireEvent.contextMenu(v.root, { clientX: 20, clientY: 20 });
    expect(screen.queryByRole("menu", { name: w.title })).toBeNull();
  });

  it("Edit ▸ Delete is off while the Shell has the keyboard (SH-044)", async () => {
    const stop = registerCommands(editCommands());
    const v = await showShell();
    act(() => v.term.textarea!.focus());
    expect(getCommand("edit:delete")!.when!()).not.toBe(true);
    stop();
  });
});

describe("header (SH-007, SH-009, SH-067)", () => {
  it("has 0.90.34's controls in its order, and folds the font controls below 560 pt", async () => {
    const v = await showShell();
    void v;
    const header = screen.getByRole("region", { name: w.title }).querySelector(".pane-header-trailing")!;
    const labels = [...header.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    expect(labels.slice(0, 8)).toEqual([w.scrollToBottom, w.find, w.copy, `${w.fontMenuHelp}: ${w.systemMono}`, w.smaller, w.bigger, w.clear, w.restart]);
    expect(screen.getByRole("button", { name: w.find })).toHaveAttribute("title", w.findHelp("⌘F"));
    expect(screen.getByRole("button", { name: w.clear })).toHaveAttribute("title", w.clearHelp("⌘K"));
    expect(screen.getByRole("button", { name: w.restart })).toHaveAttribute("title", w.restartHelp);
    expect(screen.getByRole("button", { name: w.copy })).toHaveAttribute("title", w.copyHelp);
  });
});
