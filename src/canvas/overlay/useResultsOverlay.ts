// The overlay for a tab's canvas (new in 2.1, ROADMAP B2): the tab's records, the network's
// fingerprint, the run picked in the Results pane and the overlay's switches, read into one model.
// What a tab's canvas shows is also kept by tab id, so the diagram export can draw the same thing.
import { useEffect, useMemo, useRef } from "react";
import type { BnetDocument } from "../../lib/bnet";
import { useSetting } from "../../lib/kv";
import { useCurrentFingerprint } from "../../panes/results/fingerprint";
import { asResult } from "../../panes/results/model";
import { useSelectedRun } from "../../results/selectedRun";
import { useResults } from "../../runs/state";
import { isLiveModel } from "../../live/model";
import { useLiveSource } from "../../live/useLiveSource";
import { overlayModel, type OverlayModel } from "./model";
import type { CanvasResults } from "./ResultsLayer";
import { useOverlayPrefs, type OverlayPrefs } from "./state";

const shown = new Map<string, CanvasResults>();

/** What `tabId`'s canvas draws now, for the export: nothing when hidden, and nothing while stale (a figure carries no "network changed" note). */
export function shownResults(tabId: string): CanvasResults | undefined {
  const r = shown.get(tabId);
  return r && !r.model.stale ? r : undefined;
}

export interface ResultsOverlay {
  prefs: OverlayPrefs;
  /** The model whenever the tab has a run to show (the legend and the menu read it even when hidden). */
  model: OverlayModel | null;
  /** What the canvas draws: null when hidden or there is nothing to show. */
  results: CanvasResults | null;
}

/**
 * `paused` holds the fingerprint question while a node is dragged, so nothing is asked of Rust per
 * frame: the overlay keeps what it showed, and the question is asked once when the drag ends. (The
 * fingerprint reads positions, as 0.90.34's did, so a moved node does make the run stale.)
 */
export function useResultsOverlay(tabId: string, document: BnetDocument | undefined, paused: boolean): ResultsOverlay {
  const prefs = useOverlayPrefs();
  const raw = useResults(tabId);
  const records = useMemo(() => raw.map(asResult), [raw]);
  const selected = useSelectedRun(tabId);
  const decimals = Number(useSetting<number>("output.decimals", 6));
  const held = useRef(document);
  if (!paused) held.current = document;
  // No records: nothing to be stale against, so nothing is asked.
  const fingerprint = useCurrentFingerprint(records.length ? held.current : null, raw);
  const recorded = useMemo(
    () => (records.length ? overlayModel({ records, fingerprint, metric: prefs.metric, selectedRunId: selected, decimals }) : null),
    [records, fingerprint, prefs.metric, selected, decimals],
  );
  // The source-of-values seam (src/live/): live results stand in while no run of the network as it is exists.
  const model = useLiveSource(tabId, held.current, recorded, prefs.metric, decimals);
  const results = useMemo<CanvasResults | null>(() => (model && prefs.show ? { model, color: prefs.color } : null), [model, prefs.show, prefs.color]);
  useEffect(() => {
    // Live values are not a run: the diagram export draws recorded results only.
    if (results && !isLiveModel(results.model)) shown.set(tabId, results);
    else shown.delete(tabId);
    return () => void shown.delete(tabId);
  }, [tabId, results]);
  return { prefs, model, results };
}
