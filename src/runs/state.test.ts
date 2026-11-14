// Starting and following a run (src/runs/state.ts) against the preview's replay of 0.90.34's own
// runs (src/dev/mock/runs.ts, golden/runs/).
import { describe, expect, it } from "vitest";
import { defaultHandlers } from "../dev/mockBackend";
import { mockRuns } from "../dev/mock/runs";
import { mockTauri } from "../test/tauri";
import { addTab, tabById } from "../workspace/store";
import { followRun, getRunState, onRunFinished, onRunOutput, resultsFor, reloadResults, startRun, stopRun } from "./state";
import type { RunMessage } from "../lib/types";

const examples = import.meta.glob("../../examples/*.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const display = import.meta.glob("../../golden/runs/5stationtandem.inf/qna/display.txt", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

function openExample(stem: string): string {
  return addTab({ title: `${stem}.bnet`, path: `/examples/${stem}.bnet`, document: JSON.parse(examples[`../../examples/${stem}.bnet`]) });
}

const finished = () => new Promise<void>((resolve) => {
  const stop = onRunFinished(() => {
    stop();
    resolve();
  });
});

describe("a run started for a tab", () => {
  it("writes 0.90.34's Status lines to that tab, shows its output, and files its record", async () => {
    mockTauri(defaultHandlers());
    const id = openExample("5stationtandem.inf");
    const chunks: Uint8Array[] = [];
    const stop = onRunOutput((b) => chunks.push(b));
    const done = finished();
    expect(await startRun(id, "qna")).toBe(true);
    expect(getRunState().active?.method).toBe("qna");
    await done;
    stop();
    expect(tabById(id)!.log.map((l) => l.text)).toContain("Running QNA...");
    const text = new TextDecoder().decode(new Uint8Array(chunks.flatMap((c) => [...c])));
    expect(text).toBe(Object.values(display)[0]);
    const s = getRunState();
    expect(s.active).toBeNull();
    expect(s.last).toMatchObject({ summary: "QNA finished in 0.3 s", tabId: id, kind: "success" });
    await reloadResults(id);
    expect(resultsFor(id)).toHaveLength(1);
    expect(resultsFor(id)[0].provenance.tabID).toBe(id.toUpperCase());
  });

  it("is refused while another runs, in 0.90.34's words, to the tab that asked", async () => {
    mockTauri(defaultHandlers());
    mockRuns.replayMs = 10_000;
    try {
      const a = openExample("5stationtandem.inf");
      const b = openExample("2dtandem");
      expect(await startRun(a, "qna")).toBe(true);
      expect(await startRun(b, "cmp")).toBe(false);
      expect(tabById(b)!.log.at(-1)!.text).toBe("Run Comparison was not started because QNA is already running for “5stationtandem.inf.bnet”. Stop or wait for that run first.");
      expect(getRunState().active?.tabId).toBe(a);
      const done = finished();
      expect(await stopRun()).toBe("QNA");
      await done;
      expect(tabById(a)!.log.at(-1)!.text).toBe("QNA cancelled.");
      expect(getRunState().last?.kind).toBe("warning");
      expect(resultsFor(a)).toHaveLength(0);
    } finally {
      mockRuns.replayMs = 120;
    }
  });

  it("holds output that arrives before anything shows it, for the first listener", async () => {
    mockTauri(defaultHandlers());
    const id = openExample("5stationtandem.inf");
    const done = finished();
    await startRun(id, "qna");
    await done;
    const got: number[] = [];
    onRunOutput((b) => got.push(b.length))();
    expect(got.reduce((s, n) => s + n, 0)).toBeGreaterThan(0);
  });
});

describe("the run segment belongs to the run that owns it (the P6 review)", () => {
  it("keeps the live run when the same method is refused for the same tab", async () => {
    mockTauri(defaultHandlers());
    mockRuns.replayMs = 10_000;
    try {
      const a = openExample("5stationtandem.inf");
      expect(await startRun(a, "qna")).toBe(true);
      expect(await startRun(a, "qna")).toBe(false);
      expect(getRunState().active).toMatchObject({ tabId: a, method: "qna" });
      const done = finished();
      await stopRun();
      await done;
    } finally {
      mockRuns.replayMs = 120;
    }
  });

  it("lets a run accepted before the last one's end arrived keep its segment when that end comes", async () => {
    mockTauri(defaultHandlers());
    const a = openExample("5stationtandem.inf");
    const sends: ((m: RunMessage) => void)[] = [];
    const launch = (m: (x: RunMessage) => void) => {
      sends.push(m);
      return Promise.resolve({ started: true });
    };
    const end: RunMessage = { kind: "finished", summary: "QNA finished in 0.1 s", statusBar: "QNA finished in 0.1 s", exitCode: 0, userStopped: false, succeeded: true, recordId: null, filed: null, filedReason: null };
    await followRun(a, "qna", launch);
    await followRun(a, "sbd", launch);
    expect(getRunState().active?.method).toBe("sbd");
    sends[0](end);
    expect(getRunState().active?.method).toBe("sbd");
    sends[1]({ ...end, summary: "SBD finished in 0.1 s" });
    expect(getRunState().active).toBeNull();
    expect(getRunState().last?.summary).toBe("SBD finished in 0.1 s");
  });
});
