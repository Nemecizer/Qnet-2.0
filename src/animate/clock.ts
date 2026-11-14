// The playback clock (new in 2.1, ROADMAP Phase E): simulated time as a function of wall time.
// It never runs past the horizon — the time up to which events have been received — so playback
// waits for the simulator rather than showing a moment it does not yet know.

/** The speeds offered, as multiples of the natural pace. */
export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64] as const;
export const DEFAULT_SPEED = 1;

/** At 1× about this many service completions happen per second of watching. */
export const NATURAL_COMPLETIONS_PER_SECOND = 2;
/** A frame longer than this (a stalled window) advances the clock by this much only. */
export const MAX_FRAME_MS = 100;

/**
 * Time units per second of watching at 1×, from the network's long-run completion rate: a
 * network measured in milliseconds and one measured in hours both play at a watchable pace.
 */
export function naturalPace(eventRate: number): number {
  return eventRate > 0 && Number.isFinite(eventRate) ? NATURAL_COMPLETIONS_PER_SECOND / eventRate : 1;
}

export class PlaybackClock {
  /** Simulated time, in the network's time units. */
  time = 0;
  speed: number = DEFAULT_SPEED;
  playing = false;
  /** True when the last advance was held back by the horizon. */
  waiting = false;
  /** Time units per second of watching at 1×. */
  readonly pace: number;

  constructor(pace: number, time = 0) {
    this.pace = pace;
    this.time = time;
  }

  /** Time units per second of watching at the current speed. */
  get rate(): number {
    return this.pace * this.speed;
  }

  setSpeed(speed: number) {
    this.speed = Math.min(SPEEDS[SPEEDS.length - 1], Math.max(SPEEDS[0], speed));
  }

  /** The next speed up (+1) or down (−1) the ladder. */
  step(direction: 1 | -1) {
    const i = SPEEDS.findIndex((s) => s >= this.speed);
    const at = i < 0 ? SPEEDS.length - 1 : i;
    this.setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, at + direction))]);
  }

  /** Advances by `wallMs` of watching, up to `horizon`. Returns the new time. */
  advance(wallMs: number, horizon: number): number {
    if (!this.playing || !(wallMs > 0)) return this.time;
    const want = this.time + (Math.min(wallMs, MAX_FRAME_MS) / 1000) * this.rate;
    this.waiting = want > horizon;
    this.time = Math.max(this.time, Math.min(want, horizon));
    return this.time;
  }

  /** Jumps to `time` (skip ahead, restart). */
  jump(time: number) {
    this.time = time;
    this.waiting = false;
  }
}
