// The words of closed networks (new in 2.1, ROADMAP D3): a fixed number of customers circulating,
// no source and no sink. The arithmetic is Rust's (core/src/closed.rs).
const customers = (n: number) => `${n} customer${n === 1 ? "" : "s"}`;

export const closedWords = {
  // The inspector's network section (nothing selected).
  section: "Closed Network",
  population: "Population",
  populationLabel: "Population: the number of customers circulating",
  populationHelp: "N: how many customers circulate in the closed network (1 to 10000). Nothing arrives and nothing leaves.",
  populationGlossary: "N — population: the fixed number of customers in a closed network. With no source and no sink, the same N customers move from station to station for ever.",
  unit: "customers",
  decrement: "One customer fewer",
  increment: "One customer more",
  caption: "This network has no source and no sink: the same customers circulate. Live results and Solve are exact for exponential service (a Gordon–Newell network).",
  makeOpen: "Remove Population",
  makeOpenHelp: "Make the network open again: it will then need a source and a sink",

  // A network drawn without a source and a sink, but with no population yet.
  candidateSection: "Closed Network?",
  candidateCaption: "This network has no source and no sink. Give it a population to solve it as a closed network, where a fixed number of customers circulate.",
  makeClosed: (n: number) => `Make Closed with ${customers(n)}`,
  makeClosedHelp: "Set the population, so the network is solved as a closed network",

  // Commands.
  cycleTitle: "New Closed Cycle",
  cycleHelp: "Start a closed network: three stations in a ring and six customers circulating, ready to solve",
  cycleKeywords: ["closed", "cycle", "ring", "population", "gordon", "newell", "mva", "central server", "machine repair"],
  cycleAction: "Insert Closed Cycle",
  cycleDetail: (stations: number, n: number) => `${stations} stations in a ring, ${customers(n)} circulating, no source and no sink`,
  makeClosedTitle: "Make Closed Network",
  makeClosedCommandHelp: "Give a network with no source and no sink a population, so it is solved as a closed network",
  notClosedShape: "A closed network has stations, no source and no sink",
  alreadyClosed: "This network already has a population (edit it in the Inspector with nothing selected)",
  undoMakeClosed: "Make Closed Network",
} as const;

/** The largest population solved (core/src/closed.rs `MAX_POPULATION`). */
export const MAX_POPULATION = 10000;

/** Two customers per station: what "Make Closed" starts with (src-tauri/src/diagnostics.rs `suggested_population`). */
export const suggestedPopulation = (stations: number) => Math.max(2, 2 * stations);
