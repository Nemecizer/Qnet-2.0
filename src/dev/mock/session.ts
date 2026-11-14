// The session file in the browser preview (src-tauri/src/session.rs): one snapshot kept in memory,
// and the main window's document state, which the preview has no title bar to show.
import type { MockHandlers } from "../../test/tauri";

/** What the preview last stored, and the last document state sent (tests read both). */
export const mockSession: { snapshot: unknown; saves: number; documentState: { path: string | null; edited: boolean } | null } = {
  snapshot: null,
  saves: 0,
  documentState: null,
};

export function sessionHandlers(opts: { session?: unknown } = {}): MockHandlers {
  mockSession.snapshot = opts.session ?? null;
  mockSession.saves = 0;
  mockSession.documentState = null;
  return {
    session_get: () => mockSession.snapshot,
    session_save: ({ snapshot }: { snapshot: unknown }) => {
      mockSession.snapshot = snapshot;
      mockSession.saves++;
      return null;
    },
    session_clear: () => {
      mockSession.snapshot = null;
      return null;
    },
    window_document_state: ({ path, edited }: { path: string | null; edited: boolean }) => {
      mockSession.documentState = { path, edited };
      return null;
    },
  };
}
