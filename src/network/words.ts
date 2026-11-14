// The Network menu's words (0.90.34 QnetCommands.swift `networkMenu`, its `.help` texts), as
// 0.90.34 wrote them. Titles are menuSpec's.
export const networkWords = {
  bufferModelHelp: "Network-wide queue-capacity model; changing it is undoable",
  straightenHelp: "Align nodes to a tidy left-to-right layout",
  straightenFitHelp: "Straighten the network and re-space the nodes to fill the window at 100 % (moves nodes; undoable)",
  alignLeftHelp: "Snap every selected node to the x of the leftmost one",
  alignHCentreHelp: "Snap every selected node onto the vertical line halfway between the leftmost and rightmost of them",
  alignRightHelp: "Snap every selected node to the x of the rightmost one",
  alignTopHelp: "Snap every selected node to the y of the topmost one",
  alignVCentreHelp: "Snap every selected node onto the horizontal line halfway between the topmost and bottommost of them",
  alignBottomHelp: "Snap every selected node to the y of the bottommost one",
  distributeHHelp: "Keep the leftmost and rightmost selected nodes and space the rest evenly along x (needs three or more)",
  distributeVHelp: "Keep the topmost and bottommost selected nodes and space the rest evenly along y (needs three or more)",
  noNetwork: "Draw or open a network first",
  alignNeedsTwo: "Select two or more nodes first",
  distributeNeedsThree: "Select three or more nodes first",
} as const;
