// The Help window's state (0.90.34 `HelpWindowModel`): whether it is open, the topic shown, the
// search text, and the match the reader is parked on. One window, kept for the session: a second
// request brings it forward (HELP-001). The topic is remembered in state.json under 0.90.34's key
// `help.lastTopic` (HELP-002, SET-180).
import { useSyncExternalStore } from "react";
import { raiseAuxWindow } from "../../lib/auxWindow";
import { getStateValue, setStateValues } from "../../lib/kv";
import { invalidateMenu } from "../../lib/menu";
import { matchingBlocks } from "./markdown";
import { DEFAULT_TOPIC, topic, topicBlocks } from "./topics";

export const HELP_WINDOW = "help";
export const LAST_TOPIC_KEY = "help.lastTopic";

export interface HelpState {
  open: boolean;
  /** The topic chosen this session; null until one is (the stored one shows meanwhile). */
  chosen: string | null;
  query: string;
  /** Which match of the open topic the reader is on. */
  matchIndex: number;
  /** Bumped to move the keyboard to the search field. */
  focusRequest: number;
}

let state: HelpState = { open: false, chosen: null, query: "", matchIndex: 0, focusRequest: 0 };
const listeners = new Set<() => void>();

function set(next: HelpState) {
  state = next;
  listeners.forEach((l) => l());
  // Edit ▸ Find Next / Find Previous follow the match count.
  invalidateMenu();
}

export function helpState(): HelpState {
  return state;
}

export function useHelpState(): HelpState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** The topic the window shows: this session's, else the stored one, else "SRBM in an Orthant". */
export function selectedTopic(): string {
  if (state.chosen && topic(state.chosen)) return state.chosen;
  const stored = getStateValue<unknown>(LAST_TOPIC_KEY, null);
  return typeof stored === "string" && topic(stored) ? stored : DEFAULT_TOPIC;
}

/** Shows a topic (a sidebar row, a link in an article). The match cursor goes back to the first match (HELP-013). */
export function selectTopic(id: string) {
  if (!topic(id)) return;
  const changed = id !== selectedTopic() || state.chosen !== id;
  set({ ...state, chosen: id, matchIndex: 0 });
  if (changed) void setStateValues({ [LAST_TOPIC_KEY]: id }).catch(() => {});
}

export function setQuery(query: string) {
  set({ ...state, query, matchIndex: 0 });
}

/** The trimmed query (`QnetHelpView.query`). */
export const activeQuery = () => state.query.trim();

/** How many blocks of the open topic contain the query. */
export function matchCount(): number {
  const q = activeQuery();
  return q ? matchingBlocks(topicBlocks(selectedTopic()), q).length : 0;
}

/** Find Next / Find Previous: wraps around (`stepMatch`, HELP-012). */
export function stepMatch(delta: 1 | -1) {
  const n = matchCount();
  if (n <= 0) return;
  set({ ...state, matchIndex: (Math.min(state.matchIndex, n - 1) + delta + n) % n });
}

/**
 * Opens the Help window, or brings it forward. With a topic it opens there; without one it shows
 * the last topic. Returns false for an id that names no topic (nothing opens).
 */
export function openHelp(topicId?: string): boolean {
  if (topicId !== undefined && !topic(topicId)) return false;
  if (topicId !== undefined) selectTopic(topicId);
  if (state.open) {
    raiseAuxWindow(HELP_WINDOW);
    return true;
  }
  set({ ...state, open: true });
  return true;
}

/** Edit ▸ Search Help… (⌘F): the keyboard goes to the sidebar's search field, opening the window if needed (`focusSearch`). */
export function focusHelpSearch() {
  if (state.open) raiseAuxWindow(HELP_WINDOW);
  set({ ...state, open: true, focusRequest: state.focusRequest + 1 });
}

export function closeHelp() {
  if (state.open) set({ ...state, open: false });
}

export function helpOpen(): boolean {
  return state.open;
}

/** For tests: closed, nothing chosen, no search. */
export function resetHelpWindow() {
  state = { open: false, chosen: null, query: "", matchIndex: 0, focusRequest: 0 };
  listeners.forEach((l) => l());
}
