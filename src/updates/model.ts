// What the update commands exchange (src-tauri/src/updates.rs).

/** `update_status`: whether this copy of Qnet was built to update itself, and its version. */
export interface UpdateStatus {
  configured: boolean;
  currentVersion: string;
}

/** A newer version, as the update server describes it. */
export interface UpdateInfo {
  version: string;
  /** The release notes: plain text or simple Markdown, never trusted as HTML. */
  notes: string | null;
  /** The day it was published, "2027-01-05". */
  date: string | null;
}

/** `update_check`: `disabled` means this copy does not check, and nothing was contacted. */
export type UpdateCheck = { state: "disabled" } | { state: "upToDate" } | ({ state: "available" } & UpdateInfo);

/** `update_install`'s progress: bytes so far, and the size when the server gave one. */
export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}
