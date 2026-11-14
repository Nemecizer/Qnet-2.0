// The simulated backend behind mock.html and the app tests: one handler per Rust command, named
// exactly as the command is (src-tauri/src/lib.rs's handler list; a Rust test fails when one is
// missing from src/dev/mock/). Each area keeps its handlers, and their state, in its own file
// there; this joins them. Handlers keep state in their closure, so a write is visible to the next read.
import type { MockHandlers } from "../test/tauri";
import type { KvValues, PersistenceWarning } from "../lib/types";
import { aiHandlers } from "./mock/ai";
import { analysisWindowHandlers } from "./mock/analysis";
import { coreHandlers } from "./mock/core";
import { diagnosticsHandlers } from "./mock/diagnostics";
import { documentHandlers } from "./mock/documents";
import { exportHandlers } from "./mock/export";
import { fileHandlers } from "./mock/files";
import { fitHandlers } from "./mock/fit";
import { helpHandlers } from "./mock/help";
import { inspectorHandlers } from "./mock/inspector";
import { kvHandlers } from "./mock/kv";
import { liveHandlers } from "./mock/live";
import { animateHandlers } from "./mock/animate";
import { menuHandlers } from "./mock/menu";
import { reportHandlers } from "./mock/reports";
import { resultsHandlers } from "./mock/results";
import { runHandlers } from "./mock/runs";
import { sessionHandlers } from "./mock/session";
import { settingsHandlers } from "./mock/settings";
import { statusHandlers } from "./mock/status";
import { shellHandlers } from "./mock/shell";
import { testsetHandlers } from "./mock/testsets";
import { sensitivityHandlers } from "./mock/sensitivity";
import { capacityHandlers } from "./mock/optimise";
import { uncertaintyHandlers } from "./mock/uncertainty";
import { transientHandlers } from "./mock/transient";
import { withQuietRuns } from "./mock/sweeps2";
import { withClosed } from "./mock/closed";
import { withExtended } from "./mock/extended";
import { withTourRuns } from "./mock/tour";
import { updateHandlers } from "./mock/updates";
import { welcomeHandlers } from "./mock/welcome";

export { mockInfo } from "./mock/core";

export interface MockOptions {
  /** Files Qnet couldn't read at launch. */
  setAside?: PersistenceWarning[];
  /** Stored settings and state at launch. */
  settings?: KvValues;
  state?: KvValues;
  /** Extra files for the preview's folder, path → text. */
  files?: Record<string, string>;
}

/** A fresh handler table. */
export function defaultHandlers(opts: MockOptions = {}): MockHandlers {
  // The guided tour's hand-drawn line gets a stand-in run (./mock/tour.ts); everything else passes through.
  // Closed networks (new in 2.1) are answered by ./mock/closed.ts; everything else passes through.
  // Networks with priorities, batch arrivals or a rate profile (new in 2.1) by ./mock/extended.ts.
  return withExtended(withClosed(withTourRuns(withQuietRuns({
    ...coreHandlers(opts),
    ...kvHandlers(opts),
    ...documentHandlers(opts),
    ...fileHandlers(),
    ...exportHandlers(),
    ...menuHandlers(),
    ...runHandlers(),
    ...resultsHandlers(),
    ...settingsHandlers(),
    ...sessionHandlers(opts as { session?: unknown }),
    ...statusHandlers(),
    ...shellHandlers(),
    ...testsetHandlers(),
    ...inspectorHandlers(),
    ...fitHandlers(),
    ...analysisWindowHandlers(),
    ...aiHandlers(),
    ...helpHandlers(),
    ...reportHandlers(),
    ...diagnosticsHandlers(),
    ...liveHandlers(),
    ...animateHandlers(),
    ...sensitivityHandlers(),
    ...capacityHandlers(),
    ...uncertaintyHandlers(),
    ...transientHandlers(),
    ...updateHandlers(),
    ...welcomeHandlers(),
  }))));
}
