// The Network menu's canvas commands (0.90.34 QnetCommands.swift `networkMenu`; ledger MENU-085,
// 089…100, CAN-210…213) and File ▸ New from Archetype… (MENU-014): the Buffer Model picker,
// Straighten, Straighten and Fit, Arrange ▸ Align/Distribute and Insert Archetype…. Each acts on
// the active tab's editor, which does the arithmetic and writes the undo names and Status lines.
// Generate Random Network… (MENU-099) is the files area's (src/workspace/files/index.tsx).
//
// Gating, as 0.90.34 had it: Buffer Model, Arrange and Insert Archetype wait while a sheet or
// modal panel is up (`sheetPresented`); Straighten and Straighten and Fit need only a network;
// Align needs two nodes in the group selection, Distribute three; New from Archetype is never
// dimmed (asking again brings the open gallery forward).
import { useCommands, type Command } from "../lib/commands";
import { MODAL_REASON, modalOpen } from "../lib/overlays";
import { activeEditor, type Editor } from "../editor";
import { openArchetypeGallery } from "../windows/archetypes/state";
import { archetypeWords } from "../windows/archetypes/words";
import { networkWords as w } from "./words";

const noModal = (): true | string => (modalOpen() ? MODAL_REASON : true);
const hasNetwork = (): true | string => (activeEditor().nodes.length ? true : w.noNetwork);

function groupOf(n: number, reason: string) {
  return (): true | string => {
    if (modalOpen()) return MODAL_REASON;
    return activeEditor().view.selectedNodeIDs.size >= n ? true : reason;
  };
}

const alignEnabled = groupOf(2, w.alignNeedsTwo);
const distributeEnabled = groupOf(3, w.distributeNeedsThree);

const arrange = (id: string, title: string, subtitle: string, when: () => true | string, run: (e: Editor) => void): Command => ({
  id,
  title,
  group: "Network",
  subtitle,
  keywords: ["arrange"],
  when,
  run: () => run(activeEditor()),
});

export function networkCommands(): Command[] {
  return [
    {
      id: "network:finite-buffers",
      title: "Finite buffers — capacity and blocking apply",
      group: "Network",
      subtitle: w.bufferModelHelp,
      keywords: ["buffer model"],
      checked: () => !activeEditor().infiniteBuffers,
      when: noModal,
      run: () => activeEditor().setInfiniteBuffers(false),
    },
    {
      id: "network:infinite-buffers",
      title: "Infinite buffers — queues are unbounded",
      group: "Network",
      subtitle: w.bufferModelHelp,
      keywords: ["buffer model"],
      checked: () => activeEditor().infiniteBuffers,
      when: noModal,
      run: () => activeEditor().setInfiniteBuffers(true),
    },
    { id: "network:straighten", title: "Straighten Network", group: "Network", subtitle: w.straightenHelp, keywords: ["layout", "tidy"], when: hasNetwork, run: () => activeEditor().straightenNetwork() },
    { id: "network:straighten-fit", title: "Straighten and Fit to Window", group: "Network", subtitle: w.straightenFitHelp, keywords: ["layout", "fit"], when: hasNetwork, run: () => activeEditor().fitNetworkToWindow() },
    arrange("network:align-left", "Align Left", w.alignLeftHelp, alignEnabled, (e) => e.alignSelectedNodesLeft()),
    arrange("network:align-hcentre", "Align Horizontal Centres", w.alignHCentreHelp, alignEnabled, (e) => e.alignSelectedNodesHorizontalCentres()),
    arrange("network:align-right", "Align Right", w.alignRightHelp, alignEnabled, (e) => e.alignSelectedNodesRight()),
    arrange("network:align-top", "Align Top", w.alignTopHelp, alignEnabled, (e) => e.alignSelectedNodesTop()),
    arrange("network:align-vcentre", "Align Vertical Centres", w.alignVCentreHelp, alignEnabled, (e) => e.alignSelectedNodesVerticalCentres()),
    arrange("network:align-bottom", "Align Bottom", w.alignBottomHelp, alignEnabled, (e) => e.alignSelectedNodesBottom()),
    arrange("network:distribute-h", "Distribute Horizontally", w.distributeHHelp, distributeEnabled, (e) => e.distributeSelectedNodesHorizontally()),
    arrange("network:distribute-v", "Distribute Vertically", w.distributeVHelp, distributeEnabled, (e) => e.distributeSelectedNodesVertically()),
    { id: "network:insert-archetype", title: "Insert Archetype…", group: "Network", subtitle: archetypeWords.insertMenuHelp, keywords: ["archetype", "template", "tandem"], when: noModal, run: () => openArchetypeGallery() },
    { id: "file:new-from-archetype", title: "New from Archetype…", group: "File", subtitle: archetypeWords.newFromHelp, keywords: ["archetype", "template", "tandem"], run: () => openArchetypeGallery() },
  ];
}

export function useNetworkCommands() {
  useCommands(networkCommands(), []);
}
