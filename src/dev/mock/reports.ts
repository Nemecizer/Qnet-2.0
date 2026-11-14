// The preview's failure reports (src-tauri/src/reports.rs): no solver runs in the preview, so no
// report is ever written here; tests put the reports they need in `mockReports.reports`.
// - report_get: the report with that id, or the "no longer there" refusal;
// - reports_reveal: records what Finder was asked to show and answers with the folder.
import type { FailureReport } from "../../lib/types";
import { mockInfo } from "./core";
import type { MockHandlers } from "../../test/tauri";

const FOLDER = "~/Library/Application Support/com.nemecj.qnet.dev/reports";

export const mockReports = {
  reports: {} as Record<string, FailureReport>,
  /** What Reveal in Finder was asked for: a report's id, or null for the reports folder. */
  revealed: [] as (string | null)[],
};

/** A report as `report_get` returns it: Linear Program exiting 1 on 2dtandem, unless overridden. */
export function sampleReport(over: Partial<FailureReport> = {}): FailureReport {
  const id = over.id ?? "20261112-143005-lp";
  return {
    id,
    createdAt: "2026-11-12T14:30:05Z",
    qnetVersion: mockInfo.version,
    buildTag: "preview",
    macosVersion: "15.5",
    chip: "Apple M3 Ultra",
    method: "lp",
    methodName: "Linear Program",
    networkTitle: "2dtandem.bnet",
    infiniteBuffers: true,
    kind: "exit",
    exitCode: 1,
    signal: null,
    durationSeconds: 12.25,
    reason: "Linear Program exited with status 1. See the originating tab's Status pane and retained output.",
    settings: { "grid size": "12", "basis size": "6", solver: "automatic" },
    sheet: {},
    seed: null,
    solverPath: "Contents/Resources/bin/BNAlp/srbm_lp",
    runtime: null,
    commands: [{ command: "Contents/Resources/bin/BNAlp/srbm_lp --input $TMPDIR/BNET_lp_77_s0.in", cwd: "$TMPDIR/BNET_lp_csv_77", ended: "exit 1", exitCode: 1, signal: null, durationSeconds: 12.2 }],
    utilisation: [
      { station: "S1", utilisation: 0.7 },
      { station: "S2", utilisation: 0.8 },
    ],
    statusLines: [
      { severity: "info", text: "Running Linear Program (BNAlp)..." },
      { severity: "error", text: "Linear Program failed (exit 1) after 12 s" },
    ],
    inputFiles: ["input.in"],
    inputsOmitted: [],
    outputTail: "Building the constraint matrix\nsrbm_lp: the LP solver reported an infeasible problem\n\nSolver exited with code 1.\n",
    stderrTail: "",
    folder: `${FOLDER}/${id}`,
    ...over,
  };
}

export function reportHandlers(): MockHandlers {
  mockReports.reports = {};
  mockReports.revealed = [];
  return {
    report_get: ({ id }: { id: string }) => {
      const r = mockReports.reports[id];
      if (!r) throw { kind: "notFound", message: "That failure report is no longer there. Qnet keeps the newest 20." };
      return r;
    },
    reports_reveal: ({ id }: { id: string | null }) => {
      mockReports.revealed.push(id ?? null);
      return id ? `${FOLDER}/${id}` : FOLDER;
    },
  };
}
