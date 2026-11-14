// The Welcome view's words (new in 2.1, ledger UX-101…112), written for students: plain, short,
// and nothing claimed about a network that its file does not show.
import { APP_NAME } from "../lib/vocabulary";

export type ExampleShape = "single" | "tandem" | "forward" | "feedback" | "reentrant" | "closed";
export type ExampleFilter = "all" | "tandem" | "feedback" | "closed" | "multiclass" | "finite";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const welcomeWords = {
  label: `Welcome to ${APP_NAME}`,
  title: `Welcome to ${APP_NAME}`,
  lead: "Draw a queueing network, press Solve, and see how long the queues get and how sure the answer is.",
  menuTitle: `Welcome to ${APP_NAME}`,
  commandSubtitle: "The start screen: a first network, recent files and the example gallery",
  close: "Close Welcome",
  closeHelp: "Close this and go to the empty canvas (Esc)",

  startHeading: "Start",
  tandem: "Start with a Tandem Line",
  tandemHelp: "Two stations in a row, already drawn and ready to Solve",
  empty: "New Empty Network",
  emptyHelp: "A blank canvas: add stations from the Tools pane",
  open: "Open…",
  openHelp: "A network file (.bnet) from this Mac",
  tour: "Take the Tour",
  tourHelp: "A short guided walk through drawing and solving a network",
  tandemStatus: "A two-station tandem line is ready. Press Solve (⌘↩) to see its queues.",
  tandemFailed: (why: string) => `Qnet couldn't build the tandem line: ${why}`,

  recentHeading: "Recent",
  recentEmptyTitle: "No recent networks yet",
  recentEmpty: "Networks you open or save will be listed here.",
  recentOpen: (name: string) => `Open ${name}`,

  examplesHeading: "Examples",
  search: "Search examples",
  searchPlaceholder: "Search",
  filterLabel: "Kind of network",
  filters: { all: "All", tandem: "Tandem lines", feedback: "Feedback", closed: "Closed", multiclass: "Several classes", finite: "Finite buffers" } satisfies Record<ExampleFilter, string>,
  /** What an example with a model feature new in 2.1 adds to its description. */
  features: { priorities: "Priority service at a station.", batchArrivals: "Customers arrive in batches.", timeVaryingRates: "The arrival rate changes over time." },
  examplesLoading: "Loading the examples…",
  examplesNoneTitle: "The bundled examples were not found",
  examplesNone: "File ▸ Open Example… says where Qnet looked.",
  examplesNoMatchTitle: "No example matches",
  examplesNoMatch: "Try a shorter search, or choose All.",
  clearSearch: "Show All Examples",
  shown: (n: number, of: number) => (n === of ? count(of, "example", "examples") : `${n} of ${count(of, "example", "examples")}`),
  exampleOpen: (name: string, description: string) => `Open ${name}: ${description}`,
  thumbnail: (name: string) => `Diagram of ${name}`,
  thumbnailEmpty: "No diagram",

  stations: (n: number) => count(n, "station", "stations"),
  circulating: (n: number) => `${count(n, "customer", "customers")} circulating`,
  classes: (n: number) => count(n, "customer class", "customer classes"),
  buffers: (infinite: boolean) => (infinite ? "infinite buffers" : "finite buffers"),
  /** What the routing in the file shows; each sentence states only that. */
  shape: {
    single: "One queue: the place to start.",
    tandem: "Stations in a row: every customer visits each one once.",
    forward: "Customers only move forward: none returns to a station.",
    feedback: "Some customers return to a station they have already visited.",
    reentrant: "Customers revisit stations as a different class each time.",
    closed: "A closed network: no source and no sink, the same customers circulate for ever.",
  } satisfies Record<ExampleShape, string>,
  multiServer: "Has stations with several servers.",

  showAtLaunch: "Show this at launch",
  showAtLaunchHelp: "Also in Settings ▸ General, and under Help ▸ Welcome to Qnet",
} as const;

export const solveButtonWords = {
  label: "Solve",
  running: "Solving…",
  runningHelp: "A run is in progress. Its progress is at the bottom of the canvas.",
  emptyHelp: "Solve needs a network: add a station, or open an example, first.",
  help: (what: string, key: string) => `${what} (${key})`,
} as const;
