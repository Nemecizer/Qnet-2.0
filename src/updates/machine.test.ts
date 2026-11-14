// The update flow, state by state, over a fake update source: no network, no Tauri.
import { describe, expect, it } from "vitest";
import { DAY_MS, UpdateFlow, type UpdateEnv, type UpdateSource } from "./machine";
import type { UpdateCheck, UpdateProgress } from "./model";

const INFO = { version: "2.2.0", notes: "- Faster charts.", date: "2027-01-05" };
const AVAILABLE: UpdateCheck = { state: "available", ...INFO };

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every pending promise callback run. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function fake(opts: { configured?: boolean; check?: () => Promise<UpdateCheck>; install?: UpdateSource["install"]; relaunch?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  const world = { now: 10 * DAY_MS, auto: true, lastCheck: 0, skipped: null as string | null, running: false, stopped: 0 };
  const source: UpdateSource = {
    status: async () => {
      calls.push("status");
      return { configured: opts.configured ?? true, currentVersion: "2.0.0" };
    },
    check: () => {
      calls.push("check");
      return (opts.check ?? (async () => AVAILABLE))();
    },
    install: (version, onProgress) => {
      calls.push(`install ${version}`);
      return (opts.install ?? (async () => {}))(version, onProgress);
    },
    relaunch: () => {
      calls.push("relaunch");
      return (opts.relaunch ?? (async () => {}))();
    },
  };
  const env: UpdateEnv = {
    now: () => world.now,
    auto: () => world.auto,
    lastCheck: () => world.lastCheck,
    setLastCheck: (ms) => void (world.lastCheck = ms),
    skipped: () => world.skipped,
    setSkipped: (v) => void (world.skipped = v),
    runActive: async () => world.running,
    stopRun: async () => {
      world.stopped++;
      world.running = false;
    },
    sleep: () => Promise.resolve(),
  };
  return { flow: new UpdateFlow(source, env), calls, world };
}

describe("a copy of Qnet that was not built to update", () => {
  it("says so when asked, and never asks the source to check", async () => {
    const { flow, calls } = fake({ configured: false });
    await flow.checkNow();
    expect(flow.get()).toEqual({ phase: "disabled" });
    expect(calls).toEqual(["status"]);
  });

  it("does nothing at launch", async () => {
    const { flow, calls, world } = fake({ configured: false });
    expect(await flow.checkAtLaunch()).toBe(false);
    expect(flow.get()).toEqual({ phase: "idle" });
    expect(calls).toEqual(["status"]);
    expect(world.lastCheck).toBe(0);
  });

  it("shows the same sheet if the backend answers Disabled", async () => {
    const { flow } = fake({ check: async () => ({ state: "disabled" }) });
    await flow.checkNow();
    expect(flow.get()).toEqual({ phase: "disabled" });
  });
});

describe("checking", () => {
  it("reports up to date, with the version", async () => {
    const { flow } = fake({ check: async () => ({ state: "upToDate" }) });
    await flow.checkNow();
    expect(flow.get()).toEqual({ phase: "upToDate", currentVersion: "2.0.0" });
  });

  it("shows Checking… while it waits, and offers what it finds", async () => {
    const answer = deferred<UpdateCheck>();
    const { flow } = fake({ check: () => answer.promise });
    const done = flow.checkNow();
    await settle();
    expect(flow.get()).toEqual({ phase: "checking" });
    answer.resolve(AVAILABLE);
    await done;
    expect(flow.get()).toEqual({ phase: "available", info: INFO, currentVersion: "2.0.0" });
  });

  it("drops the answer to a check the user cancelled", async () => {
    const answer = deferred<UpdateCheck>();
    const { flow } = fake({ check: () => answer.promise });
    const done = flow.checkNow();
    await settle();
    flow.dismiss();
    answer.resolve(AVAILABLE);
    await done;
    expect(flow.get()).toEqual({ phase: "idle" });
  });

  it("gives a failed check's sentence and details", async () => {
    const { flow } = fake({ check: async () => Promise.reject({ kind: "unavailable", message: "Qnet couldn't reach the update server.", detail: "dns error" }) });
    await flow.checkNow();
    expect(flow.get()).toEqual({ phase: "error", message: "Qnet couldn't reach the update server.", detail: "dns error", retry: null });
  });
});

describe("the check when Qnet starts", () => {
  it("runs at most once a day", async () => {
    const { flow, calls, world } = fake({ check: async () => ({ state: "upToDate" }) });
    expect(await flow.checkAtLaunch()).toBe(true);
    expect(world.lastCheck).toBe(world.now);
    world.now += DAY_MS - 1;
    expect(await flow.checkAtLaunch()).toBe(false);
    world.now += 1;
    expect(await flow.checkAtLaunch()).toBe(true);
    expect(calls.filter((c) => c === "check")).toHaveLength(2);
    // Up to date at launch says nothing.
    expect(flow.get()).toEqual({ phase: "idle" });
  });

  it("does not run with “Check for updates automatically” off", async () => {
    const { flow, calls, world } = fake();
    world.auto = false;
    expect(await flow.checkAtLaunch()).toBe(false);
    expect(calls).toEqual(["status"]);
  });

  it("offers an available version", async () => {
    const { flow } = fake();
    await flow.checkAtLaunch();
    expect(flow.get()).toMatchObject({ phase: "available", info: INFO });
  });

  it("stays quiet about a skipped version, which Check for Updates… still shows", async () => {
    const { flow, world } = fake();
    await flow.checkAtLaunch();
    await flow.skip();
    expect(world.skipped).toBe("2.2.0");
    expect(flow.get()).toEqual({ phase: "idle" });
    world.now += 2 * DAY_MS;
    expect(await flow.checkAtLaunch()).toBe(true);
    expect(flow.get()).toEqual({ phase: "idle" });
    await flow.checkNow();
    expect(flow.get()).toMatchObject({ phase: "available" });
  });

  it("offers the version after a skipped one", async () => {
    const { flow, world } = fake({ check: async () => ({ state: "available", version: "2.3.0", notes: null, date: null }) });
    world.skipped = "2.2.0";
    await flow.checkAtLaunch();
    expect(flow.get()).toMatchObject({ phase: "available", info: { version: "2.3.0" } });
  });

  it("says nothing when the server can't be reached", async () => {
    const { flow } = fake({ check: async () => Promise.reject(new Error("offline")) });
    expect(await flow.checkAtLaunch()).toBe(true);
    expect(flow.get()).toEqual({ phase: "idle" });
  });

  it("checks when the clock was set back past the last check", async () => {
    const { flow, world } = fake({ check: async () => ({ state: "upToDate" }) });
    world.lastCheck = world.now + 5 * DAY_MS;
    expect(await flow.checkAtLaunch()).toBe(true);
  });
});

describe("installing", () => {
  it("shows the download's progress, then relaunches", async () => {
    const gate = deferred();
    let progress!: (p: UpdateProgress) => void;
    const { flow, calls, world } = fake({
      install: (_v, onProgress) => {
        progress = onProgress;
        return gate.promise;
      },
    });
    world.skipped = "2.1.0";
    await flow.checkNow();
    const done = flow.install();
    await settle();
    expect(flow.get()).toEqual({ phase: "downloading", info: INFO, downloaded: 0, total: null });
    progress({ downloaded: 21_000_000, total: 84_000_000 });
    expect(flow.get()).toEqual({ phase: "downloading", info: INFO, downloaded: 21_000_000, total: 84_000_000 });
    gate.resolve();
    await done;
    expect(calls).toEqual(["status", "check", "install 2.2.0", "relaunch"]);
    expect(flow.get()).toEqual({ phase: "relaunching", info: INFO });
    expect(world.skipped).toBeNull();
  });

  it("reports a download that failed, and Try Again downloads again", async () => {
    let attempt = 0;
    const { flow, calls } = fake({ install: async () => (++attempt === 1 ? Promise.reject({ kind: "unavailable", message: "Qnet couldn't reach the update server." }) : undefined) });
    await flow.checkNow();
    await flow.install();
    expect(flow.get()).toEqual({ phase: "error", message: "Qnet couldn't reach the update server.", detail: null, retry: INFO });
    expect(calls).not.toContain("relaunch");
    await flow.install();
    expect(flow.get()).toEqual({ phase: "relaunching", info: INFO });
  });

  it("reports the bad signature the updater found, and does not relaunch", async () => {
    const message = "The update was downloaded, but it isn't signed by Qnet's author, so it was not installed. This copy of Qnet is unchanged.";
    const { flow, calls } = fake({ install: async () => Promise.reject({ kind: "failed", message, detail: "Signature verification failed" }) });
    await flow.checkNow();
    await flow.install();
    expect(flow.get()).toEqual({ phase: "error", message, detail: "Signature verification failed", retry: INFO });
    expect(calls).not.toContain("relaunch");
  });

  it("says the new version opens next time if Qnet did not relaunch, and Relaunch Now tries again", async () => {
    let refuse = true;
    const { flow, calls } = fake({ relaunch: async () => (refuse ? Promise.reject(new Error("still running")) : undefined) });
    await flow.checkNow();
    await flow.install();
    expect(flow.get()).toEqual({ phase: "ready", info: INFO });
    // Put away, then asked again: it is not downloaded twice.
    flow.dismiss();
    await flow.checkNow();
    expect(flow.get()).toEqual({ phase: "ready", info: INFO });
    refuse = false;
    await flow.relaunch();
    expect(flow.get()).toEqual({ phase: "relaunching", info: INFO });
    expect(calls.filter((c) => c.startsWith("install"))).toHaveLength(1);
  });
});

describe("while a solver run is in progress", () => {
  it("waits for the run before installing, and never stops it", async () => {
    const { flow, calls, world } = fake();
    world.running = true;
    await flow.checkNow();
    const done = flow.install();
    await settle();
    expect(flow.get()).toEqual({ phase: "deferred", info: INFO, before: "install", stopping: false });
    expect(calls).toEqual(["status", "check"]);
    expect(world.stopped).toBe(0);
    world.running = false;
    await done;
    expect(calls).toEqual(["status", "check", "install 2.2.0", "relaunch"]);
    expect(world.stopped).toBe(0);
  });

  it("stops the run only when the user says so, then installs", async () => {
    const { flow, calls, world } = fake();
    world.running = true;
    await flow.checkNow();
    const done = flow.install();
    await settle();
    await flow.stopRunAndContinue();
    await done;
    expect(world.stopped).toBe(1);
    expect(calls).toContain("install 2.2.0");
    expect(flow.get()).toEqual({ phase: "relaunching", info: INFO });
  });

  it("installs nothing after Not Now", async () => {
    const { flow, calls, world } = fake();
    world.running = true;
    await flow.checkNow();
    const done = flow.install();
    await settle();
    flow.postpone();
    world.running = false;
    await done;
    expect(flow.get()).toEqual({ phase: "idle" });
    expect(calls).toEqual(["status", "check"]);
  });

  it("holds the relaunch for a run that started during the download", async () => {
    const gate = deferred();
    const { flow, calls, world } = fake({ install: () => gate.promise });
    await flow.checkNow();
    const done = flow.install();
    await settle();
    world.running = true;
    gate.resolve();
    await settle();
    expect(flow.get()).toEqual({ phase: "deferred", info: INFO, before: "relaunch", stopping: false });
    expect(calls).not.toContain("relaunch");
    world.running = false;
    await done;
    expect(calls[calls.length - 1]).toBe("relaunch");
  });

  it("leaves the run alone after Relaunch Later; the new version is kept for the next start", async () => {
    const gate = deferred();
    const { flow, calls, world } = fake({ install: () => gate.promise });
    await flow.checkNow();
    const done = flow.install();
    await settle();
    world.running = true;
    gate.resolve();
    await settle();
    flow.postpone();
    world.running = false;
    await done;
    expect(calls).not.toContain("relaunch");
    expect(world.stopped).toBe(0);
    await flow.checkNow();
    expect(flow.get()).toEqual({ phase: "ready", info: INFO });
  });
});
