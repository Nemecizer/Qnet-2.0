// The preview's Help and About commands (src-tauri/src/help.rs).
// - help_show: a Help topic printed in the Shell through the run path: `output` then `finished`
//   under the topic's label; refused, with the registry's sentence, while a run is active.
// - about_info: when the build was made (a fixed moment in the preview).
import { channelSend, type MockHandlers } from "../../test/tauri";
import type { AboutInfo, RunMessage } from "../../lib/types";
import { mockDisplayLabel } from "./runs";

export interface ShownHelp {
  tabId: string;
  title: string;
  label: string;
  text: string;
}

/** What the preview was asked to print (tests read it), and the build time About shows. */
export const mockHelp = {
  shown: [] as ShownHelp[],
  /** 12 May 2026, 06:06 local time. */
  builtMs: new Date(2026, 4, 12, 6, 6).getTime() as number | null,
};

export function helpHandlers(): MockHandlers {
  mockHelp.shown = [];
  mockHelp.builtMs = new Date(2026, 4, 12, 6, 6).getTime();
  return {
    help_show: async ({ request, channel }: { request: ShownHelp; channel: unknown }) => {
      if (!/^help_[a-z0-9_]+$/.test(request.label)) throw { kind: "failed", message: `“${request.label}” is not a Help topic's label.` };
      const send = (m: RunMessage) => channelSend(channel, m);
      const label = mockDisplayLabel(request.label);
      // The one run slot is the runs mock's: ask it, as the registry would.
      const { invoke } = await import("@tauri-apps/api/core");
      const active = (await invoke("run_active").catch(() => null)) as { displayLabel: string; tabTitle: string } | null;
      if (active) {
        send({ kind: "status", text: `${label} was not started because ${active.displayLabel} is already running for “${active.tabTitle}”. Stop or wait for that run first.`, severity: "warning" });
        return { started: false };
      }
      mockHelp.shown.push({ ...request });
      setTimeout(() => {
        const bytes = new TextEncoder().encode(request.text.endsWith("\n") ? request.text : `${request.text}\n`);
        let bin = "";
        for (const b of bytes) bin += String.fromCharCode(b);
        send({ kind: "output", data: btoa(bin) });
        const summary = `${label} finished in 0.0 s`;
        send({ kind: "finished", summary, statusBar: `${summary} · ${request.title}`, exitCode: 0, userStopped: false, succeeded: true, recordId: null, filed: null, filedReason: null });
      }, 0);
      return { started: true };
    },
    about_info: (): AboutInfo => ({ builtMs: mockHelp.builtMs }),
  };
}
