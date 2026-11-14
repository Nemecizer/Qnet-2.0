// The Welcome view and the toolbar's Solve button (new in 2.1, ROADMAP C1; ledger UX-101…112).
//
// For the rest of the app:
//   openWelcome()      shows the view (over a blank tab; it never covers a network);
//   closeWelcome()     dismisses it;
//   TOUR_COMMAND       "tour:start": while a command with this id is registered, the view offers
//                      "Take the Tour", which closes the view and runs it.
import { useCommands, type Command } from "../lib/commands";
import { MODAL_REASON, modalOpen } from "../lib/overlays";
import { openWelcome } from "./state";
import { welcomeWords as w } from "./words";

export { WelcomeHost, WelcomeView, TOUR_COMMAND } from "./Welcome";
export { SolveToolbarButton } from "./SolveButton";
export { openWelcome, closeWelcome, resetWelcome, welcomeMode, SHOW_AT_LAUNCH_KEY } from "./state";

const noModal = (): true | string => (modalOpen() ? MODAL_REASON : true);

export function welcomeCommands(): Command[] {
  return [
    { id: "help:welcome", title: w.menuTitle, group: "Help", subtitle: w.commandSubtitle, keywords: ["start", "examples", "gallery", "recent", "tandem", "begin", "first"], when: noModal, run: () => openWelcome() },
    // The Window menu's item: the same thing under a second id (a menu names each command once).
    { id: "window:welcome", title: w.menuTitle, group: "Window", menuOnly: true, when: noModal, run: () => openWelcome() },
  ];
}

/** Help ▸ Welcome to Qnet and Window ▸ Welcome to Qnet. */
export function useWelcomeCommands() {
  useCommands(welcomeCommands(), []);
}
