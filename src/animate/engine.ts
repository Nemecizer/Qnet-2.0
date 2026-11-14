// One animation run (new in 2.1, ROADMAP Phase E): it starts a simulation in Rust, keeps a few
// seconds of events ahead of the playback clock, plays them into the bookkeeping as the clock
// passes them, and can skip ahead or restart. Requests go out one at a time, in order, so a skip
// can never be overtaken by a chunk asked for before it.
//
// Nothing here touches the document, a run record or a file: the run exists in memory, here and
// in src-tauri/src/animate.rs, and ends with `dispose`.
import { api } from "../lib/api";
import type { BnetDocument } from "../lib/bnet";
import { naturalPace, PlaybackClock } from "./clock";
import { AnimState, EventBuffer, type AnimateChunk, type AnimateLayout, type AnimateStart } from "./model";

/** Ask for more when less than this much watching is buffered, and then for this much. */
export const LOOKAHEAD_SECONDS = 1;
export const FETCH_SECONDS = 3;
/** The most arrivals and completions asked for at once. */
export const FETCH_STEPS = 4000;
/** Skip Ahead passes about this many service completions. */
export const SKIP_COMPLETIONS = 1000;
/** The strip chart shows this many seconds of watching at 1×. */
export const WINDOW_SECONDS = 60;
/** The controls are told of progress at most this often. */
export const PUBLISH_MS = 250;

export type Phase = "starting" | "running" | "refused" | "failed";

/** A whole number 0 … 2³² − 1, from the system's generator. */
export function newSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0];
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e));

export class AnimationEngine {
  phase: Phase = "starting";
  /** Why the network cannot be animated (phase "refused" or "failed"). */
  message = "";
  seed = 0;
  layout: AnimateLayout | null = null;
  state: AnimState | null = null;
  clock = new PlaybackClock(1);
  /** Every event up to this time has been received. */
  horizon = 0;
  /** A skip is being computed. */
  skipping = false;
  /** Bumped whenever the controls should look again. */
  version = 0;

  private buffer = new EventBuffer();
  private session: number | null = null;
  /** The run this engine is on: answers for an earlier one are dropped. */
  private run = 0;
  private asking = false;
  private chain: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private lastFrame: number | null = null;
  private lastPublish = 0;
  private disposed = false;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private publish() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.chain.then(job, job);
    this.chain = next.catch(() => {});
    return next;
  }

  /** Starts a run of `document` from `seed`, replacing any run in progress. */
  start(document: BnetDocument, seed: number, opts: { play?: boolean; speed?: number } = {}): Promise<void> {
    const mine = ++this.run;
    const old = this.session;
    this.session = null;
    this.phase = "starting";
    this.message = "";
    this.seed = seed;
    this.buffer.clear();
    this.skipping = false;
    this.asking = false;
    this.lastFrame = null;
    const speed = opts.speed ?? this.clock.speed;
    this.publish();
    return this.enqueue(async () => {
      if (old !== null) await api.animateStop(old).catch(() => {});
      let started: AnimateStart;
      try {
        started = await api.animateStart(document, seed);
      } catch (e) {
        if (mine !== this.run || this.disposed) return;
        // A refusal carries its reason code as the detail (src-tauri/src/animate.rs).
        this.phase = (e as { detail?: unknown })?.detail ? "refused" : "failed";
        this.message = messageOf(e);
        this.layout = null;
        this.state = null;
        this.publish();
        return;
      }
      if (mine !== this.run || this.disposed) {
        await api.animateStop(started.session).catch(() => {});
        return;
      }
      this.session = started.session;
      this.layout = started.layout;
      this.clock = new PlaybackClock(naturalPace(started.layout.eventRate), started.snapshot.time);
      this.clock.setSpeed(speed);
      this.clock.playing = opts.play ?? true;
      this.state = new AnimState(started.layout, started.snapshot, WINDOW_SECONDS * this.clock.pace);
      this.horizon = started.snapshot.time;
      this.phase = "running";
      this.publish();
      this.fill();
    });
  }

  private take(chunk: AnimateChunk) {
    this.buffer.push(chunk.events);
    this.horizon = Math.max(this.horizon, chunk.time);
  }

  /** Asks for more events when the buffer runs short. */
  private fill() {
    if (this.asking || this.skipping || this.session === null || this.phase !== "running") return;
    const rate = this.clock.rate;
    if (this.horizon - this.clock.time >= LOOKAHEAD_SECONDS * rate) return;
    const session = this.session;
    const mine = this.run;
    const until = this.clock.time + FETCH_SECONDS * rate;
    this.asking = true;
    void this.enqueue(async () => {
      try {
        const chunk = await api.animateNext(session, FETCH_STEPS, until);
        if (mine !== this.run || this.disposed) return;
        this.take(chunk);
        // The simulator has stopped for good (a queue past its size limit): say why, in its words.
        if (chunk.stopped) this.fail(chunk.stopped);
      } catch (e) {
        if (mine !== this.run || this.disposed) return;
        this.fail(e);
      } finally {
        if (mine === this.run) this.asking = false;
      }
    });
  }

  private fail(e: unknown) {
    this.phase = "failed";
    this.message = messageOf(e);
    this.clock.playing = false;
    this.publish();
  }

  /**
   * One frame at wall time `nowMs`: advances the clock, plays the events it passed, and asks for
   * more when needed. Returns how many events were played.
   */
  frame(nowMs: number): number {
    if (this.phase !== "running" || !this.state) return 0;
    const dt = this.lastFrame === null ? 0 : nowMs - this.lastFrame;
    this.lastFrame = nowMs;
    let played = 0;
    if (this.clock.playing && !this.skipping) {
      const t = this.clock.advance(dt, this.horizon);
      played = this.buffer.playInto(this.state, t);
      this.fill();
    }
    if (nowMs - this.lastPublish >= PUBLISH_MS) {
      this.lastPublish = nowMs;
      this.publish();
    }
    return played;
  }

  /** Forgets the last frame's time, so a pause (or a hidden window) is not played as one long frame. */
  rest() {
    this.lastFrame = null;
  }

  get playing(): boolean {
    return this.phase === "running" && this.clock.playing;
  }

  setPlaying(on: boolean) {
    if (this.phase !== "running") return;
    this.clock.playing = on;
    this.lastFrame = null;
    if (on) this.fill();
    this.publish();
  }

  toggle() {
    this.setPlaying(!this.clock.playing);
  }

  setSpeed(speed: number) {
    this.clock.setSpeed(speed);
    this.fill();
    this.publish();
  }

  stepSpeed(direction: 1 | -1) {
    this.clock.step(direction);
    this.fill();
    this.publish();
  }

  /** How far Skip Ahead goes, in time units. */
  skipSpan(): number {
    const rate = this.layout?.eventRate ?? 0;
    return rate > 0 && Number.isFinite(rate) ? SKIP_COMPLETIONS / rate : 500 * this.clock.pace;
  }

  /** Jumps ahead without drawing what happens on the way; the averages keep counting. */
  skip(): Promise<void> {
    if (this.phase !== "running" || this.session === null || this.skipping || !this.state) return Promise.resolve();
    const session = this.session;
    const mine = this.run;
    const span = this.skipSpan();
    this.skipping = true;
    this.publish();
    return this.enqueue(async () => {
      try {
        // Whatever was asked for before has been answered by now: skip from where the simulator is.
        const chunk = await api.animateSkip(session, Math.max(this.horizon, this.clock.time) + span);
        if (mine !== this.run || this.disposed || !this.state || !chunk.snapshot) return;
        this.buffer.clear();
        this.state.adopt(chunk.snapshot, chunk.stats);
        this.horizon = chunk.time;
        this.clock.jump(chunk.time);
        this.lastFrame = null;
        if (chunk.stopped) this.fail(chunk.stopped);
      } catch (e) {
        if (mine !== this.run || this.disposed) return;
        this.fail(e);
      } finally {
        if (mine === this.run) {
          this.skipping = false;
          this.publish();
          this.fill();
        }
      }
    });
  }

  /** Ends the run and frees it in Rust. */
  dispose() {
    this.disposed = true;
    this.run++;
    const s = this.session;
    this.session = null;
    this.listeners.clear();
    if (s !== null) void this.enqueue(() => api.animateStop(s).catch(() => {}));
  }
}
