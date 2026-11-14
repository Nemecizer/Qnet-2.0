// The update flow as a state machine with nothing of Tauri in it (A5, ledger UX-501…): what is
// asked of the update source and when, and what the sheet shows. The real source and environment
// are in ./index.tsx; the tests drive this with fakes (./machine.test.ts), so every state is
// exercised without a network.
//
// The rules it keeps:
// - A copy not built to update never asks the source to check: `checkNow` shows the "does not
//   check" sheet, `checkAtLaunch` does nothing.
// - At launch it checks at most once a day, only with "Check for updates automatically" on, says
//   nothing unless a version is available, and never shows a version the user skipped.
// - A solver run is never interrupted: with a run in progress the install waits for it, and so
//   does the relaunch if a run started while the download was under way. The user may stop the
//   run from the sheet instead; nothing else stops one.
// - The relaunch goes through Quit's own path (the source's `relaunch`), so the quit prompt and
//   the session save happen as they do for ⌘Q.
import type { UpdateCheck, UpdateInfo, UpdateProgress, UpdateStatus } from "./model";

/** Where updates come from: Rust's updater in the app, a fake in the tests. */
export interface UpdateSource {
  status(): Promise<UpdateStatus>;
  check(): Promise<UpdateCheck>;
  /** Downloads, verifies and installs `version`; rejects with a sentence when any of it fails. */
  install(version: string, onProgress: (p: UpdateProgress) => void): Promise<void>;
  /** Quits and starts the new version. Rejects if Qnet is still running afterwards. */
  relaunch(): Promise<void>;
}

/** What the flow needs of the app around it. */
export interface UpdateEnv {
  now(): number;
  /** Settings ▸ General ▸ "Check for updates automatically". */
  auto(): boolean;
  lastCheck(): number;
  setLastCheck(ms: number): void | Promise<void>;
  skipped(): string | null;
  setSkipped(version: string | null): void | Promise<void>;
  /** Whether a solver run (or a sweep) is in progress. */
  runActive(): Promise<boolean>;
  stopRun(): Promise<unknown>;
  sleep(ms: number): Promise<void>;
}

export type UpdatePhase =
  | { phase: "idle" }
  | { phase: "disabled" }
  | { phase: "checking" }
  | { phase: "upToDate"; currentVersion: string }
  | { phase: "available"; info: UpdateInfo; currentVersion: string }
  /** A run is in progress: `before` says what waits for it. */
  | { phase: "deferred"; info: UpdateInfo; before: "install" | "relaunch"; stopping: boolean }
  | { phase: "downloading"; info: UpdateInfo; downloaded: number; total: number | null }
  | { phase: "relaunching"; info: UpdateInfo }
  /** Installed, and Qnet is still this version until it next starts. */
  | { phase: "ready"; info: UpdateInfo }
  | { phase: "error"; message: string; detail: string | null; retry: UpdateInfo | null };

export const DAY_MS = 24 * 60 * 60 * 1000;
/** How often a waiting install looks whether the run has ended. */
export const WAIT_MS = 1000;

function sentence(e: unknown): { message: string; detail: string | null } {
  const o = e as { message?: unknown; detail?: unknown } | null;
  const message = o && typeof o.message === "string" && o.message.trim() ? o.message : typeof e === "string" && e.trim() ? e : "";
  return { message, detail: o && typeof o.detail === "string" ? o.detail : null };
}

export class UpdateFlow {
  private state: UpdatePhase = { phase: "idle" };
  private listeners = new Set<() => void>();
  /** Bumped whenever the user moves on: a slow answer for an abandoned step is then ignored. */
  private token = 0;
  private currentVersion = "";
  /** The version put in place this session, until Qnet restarts into it. */
  private installed: UpdateInfo | null = null;

  constructor(
    private source: UpdateSource,
    private env: UpdateEnv,
  ) {}

  get = (): UpdatePhase => this.state;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(next: UpdatePhase) {
    this.state = next;
    this.listeners.forEach((l) => l());
  }

  private fail(e: unknown, retry: UpdateInfo | null) {
    const { message, detail } = sentence(e);
    this.set({ phase: "error", message, detail, retry });
  }

  /** The launch check: silent unless there is a version to offer. Resolves to whether it asked. */
  async checkAtLaunch(): Promise<boolean> {
    if (this.state.phase !== "idle") return false;
    let status: UpdateStatus;
    try {
      status = await this.source.status();
    } catch {
      return false;
    }
    if (!status.configured || !this.env.auto()) return false;
    const now = this.env.now();
    const last = this.env.lastCheck();
    // A clock set back leaves `last` in the future: check, rather than wait for it to pass.
    if (last <= now && now - last < DAY_MS) return false;
    this.currentVersion = status.currentVersion;
    const mine = ++this.token;
    try {
      await this.env.setLastCheck(now);
      const found = await this.source.check();
      if (mine !== this.token || this.state.phase !== "idle") return true;
      if (found.state === "available" && found.version !== this.env.skipped()) {
        this.set({ phase: "available", info: { version: found.version, notes: found.notes, date: found.date }, currentVersion: status.currentVersion });
      }
    } catch {
      // A launch check that fails says nothing; Check for Updates… reports the reason.
    }
    return true;
  }

  /** Qnet ▸ Check for Updates…: always answers, with whatever it found. */
  async checkNow(): Promise<void> {
    if (["checking", "downloading", "relaunching"].includes(this.state.phase)) return;
    // An update already waiting for a run: that sheet is up. One already installed: say so
    // rather than download it again.
    if (this.state.phase === "deferred") return;
    if (this.installed) {
      this.set({ phase: "ready", info: this.installed });
      return;
    }
    const mine = ++this.token;
    let status: UpdateStatus;
    try {
      status = await this.source.status();
    } catch {
      status = { configured: false, currentVersion: "" };
    }
    if (mine !== this.token) return;
    this.currentVersion = status.currentVersion;
    if (!status.configured) {
      this.set({ phase: "disabled" });
      return;
    }
    this.set({ phase: "checking" });
    try {
      await this.env.setLastCheck(this.env.now());
      const found = await this.source.check();
      if (mine !== this.token) return;
      if (found.state === "disabled") this.set({ phase: "disabled" });
      else if (found.state === "upToDate") this.set({ phase: "upToDate", currentVersion: status.currentVersion });
      else this.set({ phase: "available", info: { version: found.version, notes: found.notes, date: found.date }, currentVersion: status.currentVersion });
    } catch (e) {
      if (mine === this.token) this.fail(e, null);
    }
  }

  /** OK, Cancel, Later, Not Now: puts the sheet away. An installed update stays installed. */
  dismiss() {
    this.token++;
    this.set({ phase: "idle" });
  }

  /** Skip This Version: the launch check stops offering it (Check for Updates… still does). */
  async skip(): Promise<void> {
    if (this.state.phase !== "available") return;
    const { version } = this.state.info;
    this.dismiss();
    await this.env.setSkipped(version);
  }

  /** Waits for the run in progress to end. False if the user moved on meanwhile. */
  private async waitForRuns(mine: number, info: UpdateInfo, before: "install" | "relaunch"): Promise<boolean> {
    while (await this.env.runActive()) {
      if (mine !== this.token) return false;
      if (this.state.phase !== "deferred") this.set({ phase: "deferred", info, before, stopping: false });
      await this.env.sleep(WAIT_MS);
    }
    return mine === this.token;
  }

  /** Install and Relaunch (and Try Again after a failed download). */
  async install(): Promise<void> {
    const info = this.state.phase === "available" ? this.state.info : this.state.phase === "error" ? this.state.retry : null;
    if (!info) return;
    const mine = ++this.token;
    try {
      if (!(await this.waitForRuns(mine, info, "install"))) return;
      this.set({ phase: "downloading", info, downloaded: 0, total: null });
      await this.source.install(info.version, (p) => {
        if (mine === this.token && this.state.phase === "downloading") this.set({ phase: "downloading", info, downloaded: p.downloaded, total: p.total });
      });
    } catch (e) {
      if (mine === this.token) this.fail(e, info);
      return;
    }
    // Installed. From here the user putting the sheet away no longer undoes anything.
    this.installed = info;
    await this.env.setSkipped(null);
    if (mine !== this.token) return;
    await this.relaunchWhenFree(mine, info);
  }

  private async relaunchWhenFree(mine: number, info: UpdateInfo): Promise<void> {
    try {
      if (!(await this.waitForRuns(mine, info, "relaunch"))) {
        // Relaunch Later: the new version is in place and opens at the next start.
        return;
      }
      this.set({ phase: "relaunching", info });
      await this.source.relaunch();
    } catch {
      if (mine === this.token) this.set({ phase: "ready", info });
    }
  }

  /** Relaunch Now, from the "installed" sheet. */
  async relaunch(): Promise<void> {
    if (this.state.phase !== "ready") return;
    await this.relaunchWhenFree(++this.token, this.state.info);
  }

  /** Stop the Run and Install / Relaunch: the one place an update stops a run, at the user's word. */
  async stopRunAndContinue(): Promise<void> {
    if (this.state.phase !== "deferred" || this.state.stopping) return;
    this.set({ ...this.state, stopping: true });
    try {
      await this.env.stopRun();
    } catch {
      // The wait goes on; the run may end by itself.
    }
  }

  /** Not Now (before the install) or Relaunch Later (after it). */
  postpone() {
    if (this.state.phase !== "deferred") return;
    this.dismiss();
  }

  /** The version this copy reported when it was last asked. */
  version(): string {
    return this.currentVersion;
  }
}
