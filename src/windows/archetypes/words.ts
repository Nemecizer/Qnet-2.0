// The archetype gallery's words (0.90.34 ArchetypeGallerySheet.swift, ArchetypeGalleryPanel.swift,
// NetworkArchetypes.swift's catalogue; QnetCommands.swift `.help` texts), kept as 0.90.34 wrote
// them. The catalogue's titles and routes are also core's (core/src/generate/archetypes.rs);
// builder.test.ts checks the two against golden/generators/archetype-catalogue.txt.
export const archetypeWords = {
  windowTitle: "Insert Archetype",
  subtitle: "Pick a starting network and set its size and load. It is inserted into the current canvas as one undoable step, already laid out and ready to run.",

  size: "Size",
  stations: "Stations",
  stationsLabel: "Number of stations",
  stationsHelp: "Number of service stations in the line (1–12)",
  servers: "Servers per station",
  serversHelp: "Parallel servers c at every station (1–16)",
  serversFieldHelp: "Parallel servers c at every station; the service rate is scaled so ρ is unchanged",

  load: "Load",
  lambda: "Arrival rate λ",
  lambdaLabel: "External arrival rate lambda",
  lambdaHelp: "Poisson arrival rate of the single source",
  rho: "Target ρ",
  rhoLabel: "Target utilisation rho",
  rhoHelp: "Service rates are back-solved as μ = α / (ρ · c), so every station lands at exactly this ρ",
  feedback: "Feedback p",
  feedbackLabel: "Feedback probability p",
  feedbackHelp: "Fraction of a station's output that goes round the feedback arc (0.00–0.90)",
  loadFooter: "λ and ρ fix the service rates: μ = α / (ρ · c) at every station, where α is the throughput the traffic equations give.",

  bufferModel: "Buffer model",
  buffers: "Buffers",
  buffersHelp: "Infinite buffers keep the network in the exact Jackson branch; finite buffers add blocking",
  infinite: "Infinite",
  finite: "Finite",
  capacity: "Capacity",
  capacityLabel: "Buffer capacity",
  capacityHelp: "Queue capacity of every inserted buffer (1–500)",

  // The buffer-model footer note (`insertNote`).
  emptyNote: (infinite: boolean) =>
    `The buffer model is network-wide. This canvas is empty, so the choice above becomes the whole network's: the insert will put it on ${infinite ? "infinite" : "finite"} buffers.`,
  besideNote: (n: number) => `The archetype is inserted clear to the right of the ${n} node${n === 1 ? "" : "s"} already on the canvas, with its own numbering continued.`,
  classNote: (classLabel: string) => ` Its source becomes ${classLabel}, and the links inserted with it are moved onto that class.`,
  exactNote: " The two blocks share no station, so a second class does not cost the analysis its exactness — a link drawn between them later is what would make the document genuinely multi-class.",
  regimeNote: (kept: boolean) => {
    const r = kept ? "infinite" : "finite";
    return ` The canvas is on ${r} buffers and an insert does not re-interpret the stations already there, so the network stays on ${r} buffers — Network ▸ Buffer Model changes it for the whole network.`;
  },

  // Blocking problems, in the order the fields are read (`problem`).
  stationsProblem: "Stations must be between 1 and 12.",
  serversProblem: "Servers must be between 1 and 16.",
  lambdaProblem: "Arrival rate λ must be a positive number.",
  rhoProblem: "Target ρ must be a number between 0.05 and 0.99.",
  feedbackProblem: "Feedback probability p must be a number between 0.00 and 0.90.",
  capacityProblem: "Buffer capacity must be between 1 and 500.",

  cancel: "Cancel",
  insert: "Insert",
  cancelHelp: "Close without changing the network (Esc)",
  insertHelp: (title: string) => `Insert ${title} into the current canvas as one undoable step (Return)`,
  blockedHelp: "Fix the highlighted values to insert",
  willInsert: (summary: string) => `Will insert: ${summary}`,
  insertAction: "Insert",
  actionName: (title: string) => `Insert ${title}`,
  decrement: (label: string) => `Decrease ${label}`,
  increment: (label: string) => `Increase ${label}`,
  failedTitle: "Couldn't build the archetype",

  // Menu items' `.help` texts (palette subtitles).
  newFromHelp: "Insert a ready-made network — tandem line, M/M/c station, fork, rework loop or re-entrant pair — at a chosen size and utilisation, as one undoable step",
  insertMenuHelp: "Insert a ready-made network into this canvas at a chosen size and utilisation, as one undoable step",

  classLabel: (i: number) => `Class ${i + 1}`,
} as const;
