// The one tour of the app (new in 2.1, ROADMAP C2; ledger UX-201, UX-214…216): the engine over the
// eight steps, the tab it works in, and what is remembered about it.
//
// The tour never touches the student's network: starting it opens a new untitled tab (infinite
// buffers, so a first model is about queues and not yet about blocking) and every step reads and
// writes that tab only. Ending it early keeps the tab, and Help ▸ Guided Tour picks up at the first
// step still to do; after the finish card, or once the tab is closed, it starts afresh.
//
// Two flags in state.json: `tour.firstModel.completed` (the finish card was reached) and
// `tour.firstModel.seen` (it was started at least once). The Welcome view offers the tour while
// neither is set (`tourOffered`); nothing starts it but the command `tour:start`.
import { useSyncExternalStore } from "react";
import { announce } from "../lib/announce";
import { emptyDocument } from "../lib/bnet";
import { getStateValue, setStateValues, useStateValue } from "../lib/kv";
import { startAgreementCommands } from "../panes/results/agreement/commands";
import { closeWelcome } from "../welcome/state";
import { addTab, selectTab, tabById } from "../workspace/store";
import { TourEngine, type TourState } from "./engine";
import { readWorld, STEPS, type World } from "./steps";
import { tourWords as w } from "./words";

export const COMPLETED_KEY = "tour.firstModel.completed";
export const SEEN_KEY = "tour.firstModel.seen";

let tabId: string | null = null;
let fingerprint: string | null = null;

const remember = (key: string) => void setStateValues({ [key]: true }).catch(() => {});

export const tour = new TourEngine<World>(STEPS, {
  world: () => readWorld(tabId, fingerprint),
  onFinish: () => remember(COMPLETED_KEY),
  onEnd: (finished) => {
    if (finished) tabId = null;
    announce(w.ended);
  },
});

export const tourTabId = () => tabId;
export const tourWorld = () => readWorld(tabId, fingerprint);

/** The tour tab's fingerprint, as the host learns it (a run of an earlier version of the network then stops counting). */
export function setTourFingerprint(fp: string | null) {
  fingerprint = fp;
}

/** `tour:start`: begins the tour in a tab of its own, or returns to the one in progress, or picks up one that was ended. */
export function startTour() {
  startAgreementCommands();
  // The Welcome view lies over a blank tab, and the tour's tab starts blank: the tour takes its place.
  closeWelcome();
  if (tour.state.phase !== "idle" && tabId && tabById(tabId)) {
    selectTab(tabId);
    return;
  }
  remember(SEEN_KEY);
  fingerprint = null;
  if (tabId && tabById(tabId)) {
    selectTab(tabId);
    tour.start(tour.firstOpen());
    return;
  }
  tabId = addTab({ title: w.tabTitle, document: { ...emptyDocument(), infiniteBuffers: true } });
  tour.start(0);
}

export function endTour() {
  tour.end();
}

export function useTour(): TourState {
  return useSyncExternalStore(tour.subscribe, () => tour.state);
}

/** The finish card has been reached at some time. */
export const tourCompleted = () => getStateValue<boolean>(COMPLETED_KEY, false) === true;

/** Whether to offer the tour unasked (the Welcome view's question): never started, never finished. */
export const tourOffered = () => !tourCompleted() && getStateValue<boolean>(SEEN_KEY, false) !== true;

export function useTourOffered(): boolean {
  const done = useStateValue<boolean>(COMPLETED_KEY, false);
  const seen = useStateValue<boolean>(SEEN_KEY, false);
  return done !== true && seen !== true;
}

/** For tests: no tour, no tab. */
export function resetTour() {
  tabId = null;
  fingerprint = null;
  tour.reset();
}
