// The Status pane's commands in the browser preview: the silent analysis (src-tauri/src/analysis.rs)
// and Save Status Log's write (src-tauri/src/status_log.rs). The preview can't run core, so the
// analysis is a stand-in: an empty canvas is "empty", anything else an analysis with no flags and
// no warnings. Tests replace it with `mockAnalysis.run`, and read what was saved in `savedStatusLogs`.
import type { BnetDocument } from "../../lib/bnet";
import type { SilentAnalysis } from "../../lib/types";
import type { MockHandlers } from "../../test/tauri";

/** The preview's home folder, written "~" in the saved-to line, as Rust abbreviates it. */
export const MOCK_HOME = "/Users/preview";

/** A blank analysis of `outcome`, every flag off. */
export function blankAnalysis(outcome: SilentAnalysis["outcome"] = "analysed"): SilentAnalysis {
  return {
    outcome,
    error: null,
    utilisation: {},
    warnings: [],
    isAnalyticallyTractable: false,
    tractabilityIsExact: false,
    tractabilityTitle: "",
    tractabilityDetail: "",
    tractabilityMeans: [],
    tractabilityMeansLabel: "",
    tractabilityExplanation: "",
    hasFeedback: false,
    feedbackDescription: "",
    feedbackQuality: "notReentrant",
    feedbackCriteria: [],
    stationNames: [],
    stationOrderIsAmbiguous: false,
    throughputs: null,
    nonExponentialStations: [],
    status: [],
  };
}

function standIn(doc: BnetDocument): SilentAnalysis {
  if (!doc.nodes?.length) return blankAnalysis("empty");
  return { ...blankAnalysis(), status: ["Silent analysis ρ: (the browser preview has no analysis)", "No warnings — banner hidden."] };
}

/** What `analysis_run` answers; tests set `run` (and may throw from it). */
export const mockAnalysis: { run: (doc: BnetDocument) => SilentAnalysis; calls: number } = { run: standIn, calls: 0 };

/** Path → text of every status log the preview saved. */
export const savedStatusLogs: Record<string, string> = {};

export function statusHandlers(): MockHandlers {
  mockAnalysis.run = standIn;
  mockAnalysis.calls = 0;
  for (const k of Object.keys(savedStatusLogs)) delete savedStatusLogs[k];
  return {
    analysis_run: ({ document }: { document: BnetDocument }) => {
      mockAnalysis.calls++;
      return mockAnalysis.run(document);
    },
    status_log_write: ({ path, text }: { path: string; text: string }) => {
      if (path.startsWith("/readonly/")) throw { kind: "failed", message: "Permission denied (os error 13)" };
      savedStatusLogs[path] = text;
      return path.startsWith(`${MOCK_HOME}/`) ? `~${path.slice(MOCK_HOME.length)}` : path;
    },
  };
}
