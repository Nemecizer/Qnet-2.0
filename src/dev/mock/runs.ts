// Runs in the browser preview and the tests (src-tauri/src/runs.rs): no solver runs here, so a
// run of method M on an example E replays what Qnet 0.90.34 itself did for it, from
// golden/runs/<E>/<M>/ — its Status lines (status.txt; the solver's stderr inbox is left out),
// the Shell pane's bytes (display.txt), its summary and exit status, and the Results record it
// filed (record.json, re-keyed to this tab and given a fresh id). The example is the tab's title
// without ".bnet"; anything else is refused with a sentence that says so.
//
// One run at a time, as the real registry: a second start while one replays is refused with
// 0.90.34's sentence. A replay takes REPLAY_MS so the run segment can be seen and stopped.
import type { MockHandlers } from "../../test/tauri";
import { channelSend } from "../../test/tauri";
import type { ActiveRunInfo, RunMessage, RunRecord, RunStartRequest } from "../../lib/types";

const files = import.meta.glob("../../../golden/runs/*/*/{status.txt,display.txt,summary.txt,exit.txt,record.json}", {
  query: "?raw",
  import: "default",
}) as Record<string, () => Promise<string>>;

const at = (example: string, method: string, file: string) => `../../../golden/runs/${example}/${method}/${file}`;

/** How long a replayed run takes. Tests may shorten it. */
export const mockRuns = { replayMs: 120, records: [] as RunRecord[], starts: [] as RunStartRequest[] };

/** 0.90.34's display labels for the run labels (runner/src/supervisor/labels.rs `display_label`). */
const DISPLAY: Record<string, string> = {
  inf_cmp: "Run Comparison", cmp: "Run Comparison", inf_sim: "Monte Carlo", sim: "Monte Carlo", inf_sm: "Spectral", sm: "Spectral",
  qna: "QNA", rqna: "Robust QNA", sbd: "SBD", mlmc: "SRBM MLMC", lp: "Linear Program", flp: "Linear Program", fm: "Finite Element",
  mc: "Multi-class SRBM", testset: "Test Set", spc: "Spectral Convergence", primitives: "Network Primitives", analyze: "Analyze Network",
  closed_pf: "Closed Product Form", sim_inproc: "Replicated Simulation",
};
/** Swift's `capitalized`: each word's first letter upper case, the rest lower case. */
const capitalized = (s: string) => s.replace(/_/g, " ").replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
export const mockDisplayLabel = (label: string) => DISPLAY[label] ?? capitalized(label);

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function statusLines(text: string | undefined): RunMessage[] {
  if (!text) return [];
  return text
    .split("\n")
    .filter((l) => l.includes("\t"))
    .map((l) => {
      const [severity, ...rest] = l.split("\t");
      return { kind: "status", text: rest.join("\t"), severity: severity as "info" | "success" | "warning" | "error" };
    });
}

const upperUuid = () => crypto.randomUUID().toUpperCase();

export function runHandlers(): MockHandlers {
  mockRuns.records = [];
  mockRuns.starts = [];
  let active: (ActiveRunInfo & { timer: ReturnType<typeof setTimeout> | null; stop: () => void }) | null = null;

  return {
    run_start: async ({ request, channel }: { request: RunStartRequest; channel: unknown }) => {
      mockRuns.starts.push(request);
      const send = (m: RunMessage) => channelSend(channel, m);
      const example = request.title.replace(/\.bnet$/, "");
      const read = async (f: string) => (files[at(example, request.method, f)] ? await files[at(example, request.method, f)]() : undefined);
      const status = await read("status.txt");
      if (status === undefined) {
        send({ kind: "status", text: `The browser preview has no recorded run of ${mockDisplayLabel(request.method)} for “${request.title}”.`, severity: "warning" });
        return { started: false };
      }
      if (active) {
        send({
          kind: "status",
          text: `${mockDisplayLabel(request.method)} was not started because ${active.displayLabel} is already running for “${active.tabTitle}”. Stop or wait for that run first.`,
          severity: "warning",
        });
        return { started: false };
      }
      const [display, summary, exit, recordText] = await Promise.all([read("display.txt"), read("summary.txt"), read("exit.txt"), read("record.json")]);
      const exitCode = Number((exit ?? "0").trim());
      if (exit === undefined) {
        // 0.90.34 refused it: its Status lines are the whole story.
        for (const m of statusLines(status)) send(m);
        return { started: false };
      }
      for (const m of statusLines(status)) send(m);
      let record: RunRecord | null = null;
      if (recordText) {
        record = JSON.parse(recordText) as RunRecord;
        record = { ...record, id: upperUuid(), provenance: { ...record.provenance, tabID: request.tabId.toUpperCase(), networkTitle: request.title } };
      }
      const started = Date.now();
      const label = mockDisplayLabel(request.method);
      let stopped = false;
      const finish = () => {
        if (!active) return;
        clearTimeout(active.timer ?? undefined);
        active = null;
        if (!stopped) {
          if (display) send({ kind: "output", data: toBase64(display) });
        }
        const succeeded = !stopped && exitCode === 0;
        if (record && !stopped) mockRuns.records.push(record);
        const text = stopped ? `${label} cancelled after 0.1 s` : (summary ?? "").trim() || `${label} finished in 0.1 s`;
        send({
          kind: "finished",
          summary: text,
          statusBar: text,
          exitCode: stopped ? 130 : exitCode,
          userStopped: stopped,
          succeeded,
          recordId: record && !stopped ? record.id : null,
          filed: record ? (stopped ? "deleted" : (record.status as "completed" | "partial" | "failed")) : null,
          filedReason: null,
        });
      };
      active = {
        id: crypto.randomUUID(),
        label: request.method,
        displayLabel: label,
        tabId: request.tabId,
        tabTitle: request.title,
        elapsedSeconds: 0,
        fraction: null,
        stopRequested: false,
        text: `Running ${label} for ${request.title}…`,
        timer: null,
        stop: () => {
          stopped = true;
          send({ kind: "status", text: `${label} cancelled.`, severity: "warning" });
          finish();
        },
      };
      send({ kind: "progress", fraction: null, elapsedSeconds: 0, text: active.text });
      active.timer = setTimeout(finish, mockRuns.replayMs);
      void started;
      return { started: true };
    },
    run_stop: () => {
      if (!active) return null;
      const label = active.displayLabel;
      active.stop();
      return label;
    },
    run_active: () => {
      if (!active) return null;
      const { timer: _t, stop: _s, ...info } = active;
      return info;
    },
    results_list: ({ tabId }: { tabId: string | null }) => mockRuns.records.filter((r) => tabId === null || r.provenance.tabID === tabId.toUpperCase()),
    results_get: ({ id }: { id: string }) => mockRuns.records.find((r) => r.id === id) ?? null,
    results_delete: ({ id }: { id: string }) => {
      mockRuns.records = mockRuns.records.filter((r) => r.id !== id);
      return null;
    },
    results_problem: () => null,
  };
}
