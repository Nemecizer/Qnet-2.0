// The preview's updater (src-tauri/src/updates.rs). By default the preview is what every ordinary
// build is: not configured, so Check for Updates… says this copy does not check. `mockUpdates`
// (tests), or `?updates=available|current|offline|badsig` on mock.html, makes it a configured copy
// with a version to offer, none, a server that can't be reached, or a download whose signature
// doesn't match. Nothing here touches a network.
import { channelSend, type MockHandlers } from "../../test/tauri";
import type { UpdateCheck, UpdateProgress, UpdateStatus } from "../../updates/model";
import { mockInfo } from "./core";

export const MOCK_NOTES = `## Qnet 2.2

- Results on the canvas now show the 95 % interval.
- **Faster** charts for networks with many classes.
- <img src=x onerror=alert(1)> is shown as text, never run.

Thank you to everyone who reported problems.`;

export const mockUpdates = {
  configured: false,
  currentVersion: mockInfo.version,
  /** The version the server offers, or null for "up to date". */
  available: null as { version: string; notes: string | null; date: string | null } | null,
  /** What goes wrong, if anything. */
  fail: null as "offline" | "badsig" | null,
  relaunchArmed: false,
  /** Milliseconds between the download's progress steps. */
  stepMs: 250,
};

const OFFLINE = { kind: "unavailable", message: "Qnet couldn't reach the update server. Check the internet connection and try again later.", detail: "error sending request" };
const BAD_SIGNATURE = {
  kind: "failed",
  message: "The update was downloaded, but it isn't signed by Qnet's author, so it was not installed. This copy of Qnet is unchanged.",
  detail: "Signature verification failed",
};

function fromQuery() {
  const mode = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("updates");
  if (!mode) return;
  mockUpdates.configured = true;
  mockUpdates.available = mode === "current" ? null : { version: "2.2.0", notes: MOCK_NOTES, date: "2027-01-05" };
  mockUpdates.fail = mode === "offline" ? "offline" : mode === "badsig" ? "badsig" : null;
}

export function updateHandlers(): MockHandlers {
  Object.assign(mockUpdates, { configured: false, currentVersion: mockInfo.version, available: null, fail: null, relaunchArmed: false, stepMs: 250 });
  fromQuery();
  return {
    update_status: (): UpdateStatus => ({ configured: mockUpdates.configured, currentVersion: mockUpdates.currentVersion }),
    update_check: async (): Promise<UpdateCheck> => {
      if (!mockUpdates.configured) return { state: "disabled" };
      if (mockUpdates.fail === "offline") throw OFFLINE;
      return mockUpdates.available ? { state: "available", ...mockUpdates.available } : { state: "upToDate" };
    },
    update_install: async ({ version, channel }: { version: string; channel: unknown }) => {
      if (!mockUpdates.available || mockUpdates.available.version !== version) {
        throw { kind: "invalid", message: "That update is no longer the newest one Qnet knows of. Check for updates again." };
      }
      const total = 84_000_000;
      for (let i = 1; i <= 8; i++) {
        await new Promise((r) => setTimeout(r, mockUpdates.stepMs));
        channelSend(channel, { downloaded: (total * i) / 8, total } satisfies UpdateProgress);
      }
      if (mockUpdates.fail === "badsig") throw BAD_SIGNATURE;
      return null;
    },
    update_relaunch: ({ armed }: { armed: boolean }) => {
      mockUpdates.relaunchArmed = armed;
      return null;
    },
  };
}
