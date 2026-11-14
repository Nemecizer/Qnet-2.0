// The tour's engine (new in 2.1, ROADMAP C2; ledger UX-201…204): a list of steps and where the
// student is in it. It knows nothing of Qnet: a step is "done" when its condition says so about
// the world it is shown (./world.ts reads the real stores), and the engine only moves.
//
// The student does the real action in the real interface. `observe()` is called whenever the app
// changes; a step whose condition has just become true moves the tour on. Going Back to a step
// that is already done does not bounce forward again: the tour waits there for Next. A reading
// step (`manual`) always waits for Next. Show Me performs the step (and any earlier step that was
// skipped, since later steps build on them) through the step's own `show`.

export interface TourStep<W> {
  id: string;
  /** Whether what this step asks for is true of the app now. */
  done: (w: W) => boolean;
  /** A step to read: it waits for Next whatever `done` says. */
  manual?: boolean;
  /** Does the step for the student, through the commands the interface uses. */
  show?: (world: () => W) => Promise<unknown> | unknown;
  /** Called when the step becomes the current one (to bring its pane into view). */
  enter?: (w: W) => void;
}

export type TourPhase = "idle" | "running" | "finished";

export interface TourState {
  phase: TourPhase;
  /** The current step, 0-based. */
  index: number;
  /** A change of the current step's condition to true moves on. False after Back onto a done step. */
  armed: boolean;
  /** Show Me is at work. */
  working: boolean;
}

export interface TourHooks<W> {
  world: () => W;
  /** The last step was passed: the finish card shows. */
  onFinish?: () => void;
  /** The tour ended (End, Escape, or Finish on the last card). `finished` tells which. */
  onEnd?: (finished: boolean) => void;
}

export class TourEngine<W> {
  private _state: TourState = { phase: "idle", index: 0, armed: true, working: false };
  private listeners = new Set<() => void>();

  constructor(
    readonly steps: readonly TourStep<W>[],
    private hooks: TourHooks<W>,
  ) {}

  get state(): TourState {
    return this._state;
  }

  get step(): TourStep<W> | null {
    return this._state.phase === "running" ? (this.steps[this._state.index] ?? null) : null;
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(patch: Partial<TourState>) {
    this._state = { ...this._state, ...patch };
    this.listeners.forEach((l) => l());
  }

  private go(index: number, armed: boolean) {
    if (index >= this.steps.length) {
      this.set({ phase: "finished", index: this.steps.length - 1, armed: false, working: false });
      this.hooks.onFinish?.();
      return;
    }
    this.set({ phase: "running", index: Math.max(0, index), armed });
    this.steps[this._state.index].enter?.(this.hooks.world());
    this.observe();
  }

  /** Starts at `index` (the first step unless resuming). */
  start(index = 0) {
    this.set({ phase: "running", working: false });
    this.go(index, true);
  }

  /** The first step that still has something to do: where a tour that was ended picks up. */
  firstOpen(): number {
    const w = this.hooks.world();
    const i = this.steps.findIndex((s) => !s.done(w));
    return i < 0 ? this.steps.length - 1 : i;
  }

  /** Skip, or Next on a step that waits: on to the next step whatever this one's condition says. */
  next() {
    if (this._state.phase !== "running" || this._state.working) return;
    this.go(this._state.index + 1, true);
  }

  back() {
    if (this._state.working) return;
    if (this._state.phase === "finished") {
      this.set({ phase: "running" });
      this.go(this.steps.length - 1, false);
      return;
    }
    if (this._state.phase !== "running" || this._state.index === 0) return;
    this.go(this._state.index - 1, false);
  }

  end() {
    if (this._state.phase === "idle") return;
    const finished = this._state.phase === "finished";
    this.set({ phase: "idle", working: false });
    this.hooks.onEnd?.(finished);
  }

  /** The app changed: move on if the current step has just been done. */
  observe() {
    const s = this._state;
    const step = this.step;
    if (!step || s.working || step.manual) return;
    if (!step.done(this.hooks.world())) {
      if (!s.armed) this.set({ armed: true });
      return;
    }
    if (s.armed) this.go(s.index + 1, true);
  }

  /** Whether the current step's condition holds now. */
  stepDone(): boolean {
    const step = this.step;
    return !!step && step.done(this.hooks.world());
  }

  /** Does the current step for the student, and first any earlier step still undone. */
  async showMe(): Promise<void> {
    const s = this._state;
    if (s.phase !== "running" || s.working) return;
    this.set({ working: true });
    try {
      for (let i = 0; i <= s.index; i++) {
        if (this._state.phase !== "running") return;
        const step = this.steps[i];
        if (step.show && (i === s.index ? step.manual || !step.done(this.hooks.world()) : !step.done(this.hooks.world()))) await step.show(this.hooks.world);
      }
    } finally {
      if (this._state.working) this.set({ working: false });
    }
    // Done by Show Me counts as done: on to the next step even after Back.
    if (this._state.phase === "running" && this._state.index === s.index && !this.steps[s.index].manual && this.stepDone()) this.go(s.index + 1, true);
  }

  /** For tests. */
  reset() {
    this._state = { phase: "idle", index: 0, armed: true, working: false };
    this.listeners.forEach((l) => l());
  }
}
