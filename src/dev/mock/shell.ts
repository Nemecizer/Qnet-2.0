// The Shell pane's backend in the browser preview and the tests (src-tauri/src/shell.rs): no PTY
// here, so an echo shell answers — it prints a prompt, echoes what is typed, and on Return prints
// what was typed back and a new prompt. `mockShell` lets a test play the shell's side.
import type { MockHandlers } from "../../test/tauri";
import { channelSend } from "../../test/tauri";
import type { ShellMessage } from "../../lib/types";

export const MOCK_PROMPT = "\x1b]7;file://mock/Users/preview/models\x07% ";

const b64 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

export const mockShell = {
  channel: null as unknown,
  generation: 0,
  /** Every shell_start: its size, and whether it re-attached. */
  starts: [] as { cols: number; rows: number; reattached: boolean }[],
  inputs: [] as string[],
  sizes: [] as [number, number][],
  stops: 0,
  /** The saved transcript (base64), as shell.savedRawBytes holds it. */
  transcript: null as string | null,
  saves: [] as string[],
  alive: false,
  line: "",
  /** Sends bytes as the shell would. */
  send(text: string) {
    if (this.channel) channelSend(this.channel, { kind: "output", data: b64(text) } satisfies ShellMessage);
  },
  /** The shell exits. */
  exit(code: number | null = 0) {
    this.alive = false;
    if (this.channel) channelSend(this.channel, { kind: "exited", code, generation: this.generation } satisfies ShellMessage);
  },
};

export function shellHandlers(opts: { transcript?: string | null } = {}): MockHandlers {
  Object.assign(mockShell, { channel: null, generation: 0, starts: [], inputs: [], sizes: [], stops: 0, transcript: opts.transcript ?? null, saves: [], alive: false, line: "" });
  return {
    shell_start: ({ cols, rows, channel }: { cols: number; rows: number; channel: unknown }) => {
      const reattached = mockShell.alive;
      mockShell.channel = channel;
      mockShell.starts.push({ cols, rows, reattached });
      if (!reattached) {
        mockShell.generation += 1;
        mockShell.alive = true;
        mockShell.line = "";
        setTimeout(() => mockShell.send(MOCK_PROMPT), 0);
      }
      return { pid: 4242, shell: "/bin/zsh", cwd: "/", generation: mockShell.generation, reattached };
    },
    shell_input: ({ data }: { data: string }) => {
      mockShell.inputs.push(data);
      for (const ch of data) {
        if (ch === "\r") {
          const typed = mockShell.line;
          mockShell.line = "";
          mockShell.send(`\r\n${typed ? `${typed}\r\n` : ""}${MOCK_PROMPT}`);
        } else if (ch === "\x7f") {
          if (mockShell.line) {
            mockShell.line = mockShell.line.slice(0, -1);
            mockShell.send("\b \b");
          }
        } else if (ch === "\x0c") {
          mockShell.send(`\x1b[H\x1b[2J${MOCK_PROMPT}${mockShell.line}`);
        } else if (ch >= " ") {
          mockShell.line += ch;
          mockShell.send(ch);
        }
      }
      return null;
    },
    shell_resize: ({ cols, rows }: { cols: number; rows: number }) => {
      mockShell.sizes.push([cols, rows]);
      return null;
    },
    shell_stop: () => {
      mockShell.stops += 1;
      mockShell.alive = false;
      mockShell.channel = null;
      return null;
    },
    shell_transcript_load: () => mockShell.transcript,
    shell_transcript_save: ({ data }: { data: string }) => {
      if (!data) return false;
      mockShell.transcript = data;
      mockShell.saves.push(data);
      return true;
    },
    shell_transcript_clear: () => {
      mockShell.transcript = null;
      return null;
    },
  };
}
