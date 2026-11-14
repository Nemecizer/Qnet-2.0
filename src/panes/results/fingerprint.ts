// The current network's fingerprint, which a record is stale against (ledger RES-050, RES-061):
// asked of Rust (src-tauri/src/results_export.rs `results_fingerprint`, the same read and hash a
// run's record takes) whenever the tab's nodes, links or buffer mode change. Null until first
// known, and then nothing reads as stale.
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { noteStructure } from "../../results/current";

type Doc = { nodes?: unknown; links?: unknown; infiniteBuffers?: unknown; closedPopulation?: unknown };

/** `asked` is anything else whose change should ask again (the tab's records: the preview's stand-in hash knows a record's snapshot only once it is filed). */
export function useCurrentFingerprint(document: Doc | null | undefined, asked?: unknown): string | null {
  const [state, setState] = useState<{ of: unknown[]; fp: string | null }>({ of: [], fp: null });
  const nodes = document?.nodes;
  const links = document?.links;
  const infinite = document?.infiniteBuffers;
  const population = document?.closedPopulation;
  useEffect(() => {
    let live = true;
    const of = [nodes, links, infinite, population];
    if (!document) {
      setState({ of, fp: null });
      return;
    }
    api.resultsFingerprint(document).then(
      (fp) => {
        // A run made before a change of layout alone is still current (src/results/current.ts).
        noteStructure(fp, document);
        if (live) setState({ of, fp });
      },
      () => live && setState({ of, fp: null }),
    );
    return () => {
      live = false;
    };
    // The fingerprint reads the nodes, links and buffer mode only (not the zoom or pan).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, links, infinite, population, asked]);
  // The last answer stands while the next is on its way, so a drag doesn't flicker the chips.
  return state.fp;
}

/** The fingerprint now, for an export (which must not wait on a render). */
export function fingerprintNow(document: Doc | null | undefined): Promise<string | null> {
  if (!document) return Promise.resolve(null);
  return api.resultsFingerprint(document).then(
    (fp) => {
      noteStructure(fp, document);
      return fp;
    },
    () => null,
  );
}
