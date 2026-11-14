// The words of the Canvas Outline and of what the canvas says aloud (new in 2.1, ledger WF-603…608;
// docs/ACCESSIBILITY.md). The outline is the canvas as text: every node and link with its
// parameters, its result and its problems, and the same edits the pointer makes.
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const outlineWords = {
  title: "Canvas Outline",
  menuTitle: "Canvas Outline",
  menuHelp: "The network as a list: every node and link with its parameters, results and problems, and buttons to select, add, link, move and delete without the pointer",
  keywords: ["outline", "list", "accessibility", "voiceover", "screen reader", "keyboard", "nodes", "links", "table"],
  close: "Close",
  closeHelp: "Close the outline and return to the canvas (Esc)",
  summary: (nodes: number, links: number) => `${plural(nodes, "node", "nodes")}, ${plural(links, "link", "links")}`,
  empty: "The canvas is empty. Add a source, a buffer, a station and a sink below, then link them in that order.",

  addLabel: "Add a node",
  add: (kind: string) => `Add ${kind}`,
  addHelp: "Adds the node beside the selected node, or to the right of the network",
  added: (kind: string, name: string) => `Added ${kind.toLowerCase()} ${name}.`,

  nodesHeading: "Nodes",
  linksHeading: "Links",
  nodesCaption: (results: string | null) => (results ? `Nodes in reading order. ${results}.` : "Nodes in reading order. No results to show yet."),
  linksCaption: "Links, by the node they leave.",
  col: { node: "Node", kind: "Kind", parameters: "Parameters", result: "Result", problems: "Problems", link: "Link", cls: "Class", probability: "Probability" },
  noLinks: "No links yet.",
  noResult: "—",
  noResultSpoken: "no result",
  noProblems: "None",
  problems: (errors: number, warnings: number, notes: number) =>
    [errors ? plural(errors, "error", "errors") : "", warnings ? plural(warnings, "warning", "warnings") : "", notes ? plural(notes, "note", "notes") : ""].filter(Boolean).join(", "),
  bottleneck: "the bottleneck",
  tied: "equally the most loaded",
  stale: "from before the network changed",
  select: (description: string) => `Select ${description}`,
  rowsHelp: "↑ and ↓ move between rows; Return selects the row on the canvas",

  selectedHeading: "Selection",
  nothingSelected: "Nothing is selected. Choose a row above to act on it.",
  selectedNode: (kind: string, name: string) => `${kind} ${name}`,
  selectedLink: (label: string) => `Link ${label}`,
  edit: "Edit Parameters…",
  editHelp: "Open the parameters of the selection in their own panel",
  inspector: "Go to Inspector",
  inspectorHelp: "Move the keyboard to the Inspector, which shows the selection's parameters",
  remove: "Delete",
  removeHelp: "Delete the selection from the network (Undo brings it back)",
  moveLabel: "Move the node",
  move: { left: "Move Left", right: "Move Right", up: "Move Up", down: "Move Down" },
  moved: (name: string, x: string, y: string) => `${name} moved to ${x}, ${y}.`,
  linkTo: "Link to",
  linkToHelp: "The node the new link goes to",
  addLink: "Add Link",
  linkNone: "Choose a node",
  problemsOf: "Problems here",

  // Spoken when the selection changes on the canvas.
  spokenSelected: (description: string) => `Selected: ${description}`,
  spokenResult: (metric: string, value: string) => `${metric} ${value}`,
  spokenProblems: (n: number, first: string) => (n === 1 ? `1 problem: ${first}` : `${n} problems, the first: ${first}`),
  spokenNone: "Nothing selected.",
  spokenSeveral: (n: number) => `${n} nodes selected.`,
  /** The canvas's own description, read after its name. */
  canvasHelp: (outlineKey: string) =>
    `Tab and Shift Tab walk the nodes; Option Tab walks the selected node's links; the arrows move the selection; Return opens its parameters; with a tool chosen by its letter, Return places a node or makes a link. ${outlineKey} opens the Canvas Outline, the network as a list.`,
} as const;
