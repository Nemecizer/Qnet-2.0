// The overlay's switches (new in 2.1, ROADMAP B2), kept in state.json (they are how the canvas was
// left, like a split's size, not a preference a person looks for in Settings): whether results are
// shown, which metric, and whether stations are ringed in the scale's colour. One set for the app.
import { getStateValue, setStateValues, useStateValue } from "../../lib/kv";
import type { StationMetric } from "../../results/insight";
import { DEFAULT_METRIC, isStationMetric } from "./model";

export const SHOW_KEY = "canvas.results.show";
export const METRIC_KEY = "canvas.results.metric";
export const COLOR_KEY = "canvas.results.color";

export interface OverlayPrefs {
  show: boolean;
  metric: StationMetric;
  color: boolean;
}

const read = (show: unknown, metric: unknown, color: unknown): OverlayPrefs => ({ show: show !== false, metric: isStationMetric(metric) ? metric : DEFAULT_METRIC, color: color !== false });

export function overlayPrefs(): OverlayPrefs {
  return read(getStateValue<unknown>(SHOW_KEY, true), getStateValue<unknown>(METRIC_KEY, DEFAULT_METRIC), getStateValue<unknown>(COLOR_KEY, true));
}

export function useOverlayPrefs(): OverlayPrefs {
  return read(useStateValue<unknown>(SHOW_KEY, true), useStateValue<unknown>(METRIC_KEY, DEFAULT_METRIC), useStateValue<unknown>(COLOR_KEY, true));
}

const save = (patch: Record<string, unknown>) => void setStateValues(patch as Parameters<typeof setStateValues>[0]).catch(() => {});

export const setOverlayShown = (on: boolean) => save({ [SHOW_KEY]: on });
/** Choosing a metric also shows the overlay: nobody picks a quantity to keep it hidden. */
export const setOverlayMetric = (metric: StationMetric) => save({ [METRIC_KEY]: metric, [SHOW_KEY]: true });
export const setOverlayColor = (on: boolean) => save({ [COLOR_KEY]: on });
