// File ▸ Open Recent (ledger MENU-011, MENU-012, WS-121, WS-122). 0.90.34 used the system's
// list (NSDocumentController `noteNewRecentDocumentURL`, `recentDocumentURLs`, newest first, as
// many as System Settings' "Recent documents" allows: 10 by default). 2.0 keeps its own list in
// state.json under `RECENTS_KEY`, newest first, at most `RECENTS_LIMIT`, so every window sees it.
import { modalOpen } from "../../lib/overlays";
import { getStateValue, setStateValues } from "../../lib/kv";
import type { DynamicItem } from "../../lib/menu";
import { baseName } from "./paths";

export const RECENTS_KEY = "files.recentDocuments";
/** The system's default "Recent documents" count, which 0.90.34's list followed. */
export const RECENTS_LIMIT = 10;

export function recentPaths(): string[] {
  const v = getStateValue<unknown>(RECENTS_KEY, []);
  return Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : [];
}

/** Puts `path` first (once), dropping the oldest past the limit. */
export function noteRecent(path: string): Promise<void> {
  const next = [path, ...recentPaths().filter((p) => p !== path)].slice(0, RECENTS_LIMIT);
  return setStateValues({ [RECENTS_KEY]: next }).catch(() => {});
}

export function clearRecents(): Promise<void> {
  return setStateValues({ [RECENTS_KEY]: [] }).catch(() => {});
}

/** The Open Recent submenu's items: one per file, by name, then a divider when there are any. */
export function recentItems(open: (path: string) => unknown): DynamicItem[] {
  const paths = recentPaths();
  const items: DynamicItem[] = paths.map((p, i) => ({ id: `file:recent:${i}`, label: baseName(p), enabled: !modalOpen(), run: () => (modalOpen() ? undefined : open(p)) }));
  if (items.length) items.push({ id: "file:recent:divider", label: "", separator: true });
  return items;
}
