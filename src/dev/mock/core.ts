// The app's own commands in the browser preview: build information, quitting, set-aside files.
import type { AppInfo, PersistenceWarning } from "../../lib/types";
import type { MockHandlers } from "../../test/tauri";

export const mockInfo: AppInfo = {
  version: "2.1.2",
  identifier: "com.nemecj.qnet.dev",
  instance: "dev",
  buildTag: "preview",
  configDir: "~/Library/Application Support/com.nemecj.qnet.dev",
  dataDir: "~/Library/Application Support/com.nemecj.qnet.dev",
};

/** Paths "Finder" asked the preview to open; taken by `opened_files_take` (tests push to it). */
export const mockOpenedFiles: string[] = [];

/** How many times the preview was asked to quit (tests read it). */
export const quitCalls = { count: 0 };

export function coreHandlers(opts: { setAside?: PersistenceWarning[] } = {}): MockHandlers {
  return {
    app_info: () => mockInfo,
    aux_close: () => null,
    opened_files_take: () => mockOpenedFiles.splice(0),
    app_exit: () => {
      quitCalls.count++;
      return null;
    },
    persistence_warnings: () => opts.setAside ?? [],
  };
}
