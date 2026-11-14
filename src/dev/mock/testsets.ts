// Test-menu sweeps and the solver lookup in the browser preview and the tests
// (src-tauri/src/testsets.rs): no solver runs here, so a sweep replays the one 0.90.34 ran for the
// golden corpus, golden/runs/_testsets/<testset-infinite | testset-finite | spc>/ — its Shell-pane
// bytes, summary and the record it filed, re-keyed to the asking tab and filed as completed (2.0
// files a sweep that exits 0 as completed: TEST-019, TEST-029, Changed). Whatever parameters the
// sheet sent, the corpus's sweep is what is replayed; `mockSweeps.starts` keeps the requests.
//
// One sweep at a time; a second while one replays is refused with 0.90.34's sentence. (The
// Run-menu replay in ./runs.ts keeps its own slot, so the preview doesn't refuse across the two,
// and its `run_stop` doesn't stop a replaying sweep; `mockSweeps.stop()` does, for the tests.)
import type { MockHandlers } from "../../test/tauri";
import { channelSend } from "../../test/tauri";
import type { RunMessage, RunRecord, SweepStartRequest } from "../../lib/types";

const files = import.meta.glob("../../../golden/runs/_testsets/*/{display.txt,summary.txt,exit.txt,record.json}", {
  query: "?raw",
  import: "default",
}) as Record<string, () => Promise<string>>;

const at = (dir: string, file: string) => `../../../golden/runs/_testsets/${dir}/${file}`;

/** Replay length, the requests seen, and the records filed (tests read and shorten these). */
export const mockSweeps = { replayMs: 120, starts: [] as SweepStartRequest[], records: [] as RunRecord[], mcSolver: true, stop: (): string | null => null };

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function testsetHandlers(): MockHandlers {
  mockSweeps.starts = [];
  mockSweeps.records = [];
  let active: { label: string; title: string; stop: () => void } | null = null;
  return {
    sweep_start: async ({ request, channel }: { request: SweepStartRequest; channel: unknown }) => {
      mockSweeps.starts.push(request);
      const send = (m: RunMessage) => channelSend(channel, m);
      const label = request.kind === "spc" ? "Spectral Convergence" : "Test Set";
      if (active) {
        send({ kind: "status", text: `${label} was not started because ${active.label} is already running for “${active.title}”. Stop or wait for that run first.`, severity: "warning" });
        return { started: false };
      }
      const dir = request.kind === "spc" ? "spc" : `testset-${request.kind}`;
      const read = async (f: string) => (files[at(dir, f)] ? await files[at(dir, f)]() : undefined);
      const [display, summary, recordText] = await Promise.all([read("display.txt"), read("summary.txt"), read("record.json")]);
      let record = recordText ? (JSON.parse(recordText) as RunRecord) : null;
      if (record) {
        const { failureMessage: _f, ...rest } = record as RunRecord & { failureMessage?: unknown };
        record = { ...rest, id: crypto.randomUUID().toUpperCase(), status: "completed", provenance: { ...record.provenance, tabID: request.tabId.toUpperCase(), networkTitle: request.title } } as RunRecord;
      }
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (!active) return;
        if (timer) clearTimeout(timer);
        active = null;
        if (!stopped && display) send({ kind: "output", data: toBase64(display) });
        if (record && !stopped) mockSweeps.records.push(record);
        const text = stopped ? `${label} cancelled after 0.1 s` : (summary ?? "").trim() || `${label} finished in 0.1 s`;
        send({ kind: "finished", summary: text, statusBar: text, exitCode: stopped ? 130 : 0, userStopped: stopped, succeeded: !stopped, recordId: record && !stopped ? record.id : null, filed: record ? (stopped ? "deleted" : "completed") : null, filedReason: null });
      };
      mockSweeps.stop = () => {
        if (!active) return null;
        active.stop();
        return label;
      };
      active = {
        label,
        title: request.title,
        stop: () => {
          stopped = true;
          send({ kind: "status", text: `${label} cancelled.`, severity: "warning" });
          finish();
        },
      };
      send({ kind: "progress", fraction: null, elapsedSeconds: 0, text: `Running ${label} for ${request.title}… 0:00` });
      timer = setTimeout(finish, mockSweeps.replayMs);
      return { started: true };
    },
    solver_lookup: ({ name }: { name: string; subdirectory: string }) =>
      mockSweeps.mcSolver || name !== "mc_solver"
        ? { available: true, diagnostic: `Using QNET_SOLVER_ROOT: /preview/bin/${name}.` }
        : { available: false, diagnostic: `${name} was not found. Run scripts/stage-solvers.sh, or set QNET_SOLVER_ROOT to a folder whose bin holds it.` },
  };
}
