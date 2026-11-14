// The Network Model window's words, 0.90.34's to the character (NetworkModelGuideView.swift).
// src/lib/vocabulary.ts re-exports them.

const s = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const networkModelWords = {
  windowTitle: "Network Model",
  title: "Network Model",
  subtitle: "Structure and queue-capacity semantics",
  pageLabel: "Page",
  pages: { outline: "Network Outline", capacity: "Capacity & Blocking" },
  footer: "Changes to the network-wide buffer model are undoable on the canvas.",
  close: "Close",
  noNetworkTitle: "No Active Network",
  noNetworkMessage: "Open or create a network to see how Qnet models it.",

  // Network Outline.
  emptyTitle: "No Network Yet",
  emptyMessage: "Add sources, stations, buffers and sinks to build a structural outline.",
  nodesSection: "Nodes in document order",
  nodesLabel: "Network nodes",
  nodeHint: "Selects this node on the canvas",
  selected: "Selected",
  routes: "Routes",
  routesLabel: "Customer routes",
  routeHint: "Selects this route on the canvas",
  noRoutesTitle: "No Routes Yet",
  noRoutesMessage: "Connect the nodes to describe customer flow.",
  missingNode: "Missing node",
  route: (from: string, to: string) => `${from} → ${to}`,
  transition: (a: string, b: string) => `${a} → ${b}`,
  probability: (p: string) => `p = ${p}`,
  station: (servers: number, classes: number) => `${servers} server${s(servers, "", "s")} · ${classes} service class${s(classes, "", "es")}`,
  bufferFinite: (n: number) => `Finite waiting capacity ${n}`,
  bufferInfinite: (n: number) => `Unbounded in the active network model; saved finite capacity ${n}`,
  source: (family: string, parameters: string) => `${family} · ${parameters}`,
  sink: "Customers leave the network",

  // Capacity & Blocking.
  capacityTitle: "Network-Wide Capacity",
  bufferModel: "Buffer model",
  finite: "Finite buffers — capacities apply",
  infinite: "Infinite buffers — capacities are ignored",
  infiniteExplanation: "Every queue may grow without a capacity rejection or blocking event. Stability is required for a steady state.",
  finiteExplanation: "Each buffer's saved capacity applies. A run must also specify what happens when a destination is full.",
  blockingTitle: "Finite-Buffer Blocking Rule",
  unknown: "Unknown",
  pickerLabel: "Monte Carlo default",
  tableLabel: "Comparison of finite-buffer blocking rules",
  headers: ["Rule", "When a destination is full", "Effect upstream", "Typical interpretation"],
  rules: [
    {
      name: "Loss",
      fullDestination: "The arriving customer is discarded.",
      upstream: "A completing server is released immediately.",
      interpretation: "Communication, admission-control and other loss systems.",
    },
    {
      name: "BAS",
      fullDestination: "The customer is retained after service.",
      upstream: "The completed customer blocks its server until space opens; external arrivals wait outside.",
      interpretation: "Manufacturing or transfer systems with back-pressure.",
    },
    {
      name: "BAS + external loss",
      fullDestination: "Internal customers are retained; external arrivals are discarded.",
      upstream: "Internal completions block their server until space opens.",
      interpretation: "Back-pressure inside the network with admission loss at its boundary.",
    },
  ],
  srbmNote:
    "A bounded, continuously reflected SRBM is a diffusion approximation. It is not identical to discrete Loss or BAS dynamics; matching its numerics across solvers does not establish queue-model accuracy.",
} as const;
