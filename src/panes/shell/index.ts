// The Shell pane (P6). Window ▸ Shell's commands are registered when this module loads, so they
// work before the pane is first shown (Find in Shell… reveals it).
import { registerShellCommands } from "./commands";

registerShellCommands();

export { ShellPane } from "./ShellPane";
export {
  clearShell,
  confirmRestartShell,
  copyShellSelection,
  findInShell,
  pasteIntoShell,
  saveShellTranscript,
  selectAllInShell,
  shellFocused,
  shellHasSelection,
} from "./commands";
export { shellWords } from "./words";
