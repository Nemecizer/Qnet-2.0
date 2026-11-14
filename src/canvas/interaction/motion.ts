// The canvas's two animations (canvas.md §17, 0.90.34 DesignSystem `Motion`): the camera glide a
// programmatic zoom triggers (`canvasGlide`, ease-out 0.20 s, keyed on `canvasAnimationToken`) and
// the route-plan ease when the routes change (`quick`, ease-in-out 0.15 s, `AnimatedLinkLayer`).
// Under Reduce Motion both are nil in 0.90.34, so everything lands in one step. Wheel and pinch
// never bump the token, so they track the pointer 1:1.
/** Reduce Motion: Qnet's own setting on <html>, else the system's (as src/workspace/panes/commands.ts reads it). */
export function reduceMotion(): boolean {
  const m = document.documentElement.getAttribute("data-motion");
  if (m) return m === "reduce";
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Milliseconds; tests replace `now` to step an animation. */
export const motionClock = { now: () => performance.now() };

export const GLIDE_MS = 200;
export const PLAN_EASE_MS = 150;

/** CSS/SwiftUI cubic-bezier timing (x1, y1, x2, y2) evaluated at progress `t`. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (u: number) => ((ax * u + bx) * u + cx) * u;
  const sy = (u: number) => ((ay * u + by) * u + cy) * u;
  const dx = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let u = t;
    for (let i = 0; i < 8; i++) {
      const e = sx(u) - t;
      const d = dx(u);
      if (Math.abs(e) < 1e-6 || Math.abs(d) < 1e-6) break;
      u -= e / d;
    }
    return sy(Math.min(1, Math.max(0, u)));
  };
}

/** SwiftUI `.easeOut` and `.easeInOut`. */
export const easeOut = cubicBezier(0, 0, 0.58, 1);
export const easeInOut = cubicBezier(0.42, 0, 0.58, 1);

export interface Camera {
  scale: number;
  panX: number;
  panY: number;
}

/** The camera as drawn: follows the editor's transform, gliding only when the token moves. */
export class CameraMotion {
  private shown: Camera;
  private from: Camera | null = null;
  private to: Camera | null = null;
  private startedAt = 0;
  private token: number;

  constructor(target: Camera, token: number) {
    this.shown = target;
    this.token = token;
  }

  get animating(): boolean {
    return this.from !== null;
  }

  /** The camera for this frame. */
  frame(target: Camera, token: number): Camera {
    if (token !== this.token) {
      this.token = token;
      if (reduceMotion()) {
        this.from = null;
        this.shown = target;
        return target;
      }
      this.from = this.shown;
      this.to = target;
      this.startedAt = motionClock.now();
    } else if (this.from && this.to && !sameCamera(this.to, target)) {
      // A change made without the token (a wheel or pinch zoom mid-glide) lands as it is.
      this.from = null;
    }
    if (!this.from || !this.to) {
      this.shown = target;
      return target;
    }
    const t = (motionClock.now() - this.startedAt) / GLIDE_MS;
    if (t >= 1) {
      this.from = null;
      this.shown = this.to;
      return this.to;
    }
    const k = easeOut(t);
    const f = this.from;
    const g = this.to;
    this.shown = { scale: f.scale + (g.scale - f.scale) * k, panX: f.panX + (g.panX - f.panX) * k, panY: f.panY + (g.panY - f.panY) * k };
    return this.shown;
  }
}

export const sameCamera = (a: Camera, b: Camera) => a.scale === b.scale && a.panX === b.panX && a.panY === b.panY;
