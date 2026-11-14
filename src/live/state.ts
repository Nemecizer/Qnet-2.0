// The Live Results switch (new in 2.1, ROADMAP Phase D), kept in state.json beside the results
// overlay's switches (src/canvas/overlay/state.ts): how the canvas was left, not a preference to
// look for in Settings. On unless it has been turned off.
import { getStateValue, setStateValues, useStateValue } from "../lib/kv";

export const LIVE_KEY = "canvas.live.show";

export const liveShown = (): boolean => getStateValue<unknown>(LIVE_KEY, true) !== false;
export const useLiveShown = (): boolean => useStateValue<unknown>(LIVE_KEY, true) !== false;
export const setLiveShown = (on: boolean) => void setStateValues({ [LIVE_KEY]: on }).catch(() => {});
