// The seam between live results and the results overlay (new in 2.1, ROADMAP Phase D): given
// what the overlay would show from the tab's records, what it should show. A recorded run of the
// network as it is now is returned untouched; otherwise the live model when there is one.
import { useEffect, useMemo } from "react";
import type { OverlayModel } from "../canvas/overlay/model";
import type { BnetDocument } from "../lib/bnet";
import type { StationMetric } from "../results/insight";
import { useLiveCommands } from "./commands";
import { chooseModel, liveOverlayModel } from "./model";
import { useLiveShown } from "./state";
import { forgetLive, liveKey, requestLive, useLive } from "./store";

/**
 * `document` is the network to compute for; the overlay holds it still while a node is dragged, so
 * a move asks nothing (and a move alone never changes the structure key anyway).
 */
export function useLiveSource(tabId: string, document: BnetDocument | undefined, recorded: OverlayModel | null, metric: StationMetric, decimals: number): OverlayModel | null {
  useLiveCommands();
  const on = useLiveShown();
  const results = useLive(tabId);
  const key = on ? liveKey(document) : null;
  useEffect(() => {
    if (on) requestLive(tabId, document);
    else forgetLive(tabId);
    // The key is the document as far as the answer goes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, on, key]);
  useEffect(() => () => forgetLive(tabId), [tabId]);
  const live = useMemo(() => (on ? liveOverlayModel(results, tabId, metric, decimals) : null), [on, results, tabId, metric, decimals]);
  return useMemo(() => (on ? chooseModel(recorded, live, key) : recorded), [on, recorded, live, key]);
}
