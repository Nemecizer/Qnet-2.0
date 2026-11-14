// The guided tour's words (new in 2.1, ROADMAP C2; ledger UX-201…): written for a student who has
// never seen Qnet. Each step says what to do in one or two short sentences and what the thing is.
// The verbs name no device ("choose", "select", "place"): every step can be done with the pointer
// or from the keyboard (docs/ACCESSIBILITY.md), so no sentence says "click" (ledger FIX-107).
import type { Tier, Verdict } from "../results/insight";

export type StepId = "source" | "stations" | "sink" | "link" | "rate" | "solve" | "read" | "check";

export const tourWords = {
  menuTitle: "Guided Tour",
  commandSubtitle: "Build a small network, solve it and read the result, step by step (about two minutes)",
  label: "Guided tour",
  tabTitle: "Untitled",
  progress: (n: number, of: number) => `${n} of ${of}`,
  progressA11y: (n: number, of: number) => `Step ${n} of ${of}`,
  announce: (n: number, of: number, title: string, text: string) => `Guided tour, step ${n} of ${of}. ${title}. ${text}`,

  showMe: "Show Me",
  showMeHelp: "Do this step for me",
  working: "Working…",
  back: "Back",
  backHelp: "Go back one step",
  skip: "Skip",
  skipHelp: "Go to the next step without doing this one",
  next: "Next",
  nextHelp: "Go to the next step",
  end: "End Tour",
  endHelp: "End the tour (Esc). Help ▸ Guided Tour starts it again.",
  done: "Done",
  stepDone: "This step is done.",
  focus: "Focus Guided Tour",
  focusHelp: "Put the keyboard on the tour's buttons",

  ended: "The tour has ended. Help ▸ Guided Tour starts it again.",
  elsewhereTitle: "The tour is in another tab",
  elsewhere: "The tour builds its network in a tab of its own, so nothing here is changed.",
  returnToTab: "Go to the Tour's Tab",
  busy: "A run is in progress: wait for it to finish, then try again.",

  steps: {
    source: {
      title: "Add where customers arrive",
      text: (key: string) => `Choose Source in the Tools pane (or press ${key}), then place it on empty canvas. A source is where customers enter the network.`,
    },
    stations: {
      title: "Add two stations",
      text: (bufferKey: string, stationKey: string) =>
        `A station is a server, and its customers wait in a buffer in front of it. From left to right, place a Buffer (${bufferKey}), a Station (${stationKey}), a second Buffer and a second Station.`,
      count: (placed: number) => `${placed} of 4 placed.`,
    },
    sink: {
      title: "Add where customers leave",
      text: (key: string) => `Choose Sink (or press ${key}) and place it right of the last station. A sink is where served customers leave the network.`,
    },
    link: {
      title: "Link them in a line",
      text: (key: string, names: string) => `Choose Link (or press ${key}), then select each node in turn: ${names}. Each one after the first draws an arrow, the path a customer follows.`,
      next: (name: string) => `Next: select ${name}.`,
    },
    rate: {
      title: "Set a service rate",
      text: (selectKey: string, station: string, to: string) =>
        `Choose Pointer (or press ${selectKey}), select station ${station}, and in the Inspector set its Rate to ${to}, then press Return. The rate μ is how many customers the server finishes per unit of time: a faster server is busy less of the time.`,
      /** The student set a rate the line cannot keep up with: the step waits, and says what to try. */
      tooSlow: (station: string, to: string) => `That makes ${station} slower than customers arrive. Try ${to}.`,
    },
    solve: {
      title: "Solve the network",
      text: (shortcut: string) => `Press Solve (${shortcut}). Qnet chooses the best method for this network and runs it.`,
      menuHint: (shortcut: string) => `Solve is in the Run menu: Run ▸ Solve, or ${shortcut}.`,
    },
    read: {
      title: "Read the result",
      waiting: "There is no result yet. Solve the network first, or press Show Me.",
      /** "S2 is the busiest station: its server is working 90 % of the time (its utilisation), and on average 9.00 customers are there." */
      reading: (station: string, utilisation: string, count: string | null, countIs: string) =>
        `${station} is the busiest station: its server is working ${utilisation} of the time (its utilisation)${count ? `, and on average ${count} ${countIs}` : ""}.`,
      countIs: {
        "Mean queue length": "customers are waiting in its queue",
        "Mean number in system": "customers are there, waiting or being served",
        "Mean reported occupancy": "customers are there, waiting or being served",
      } as Record<string, string>,
      /** How sure to be, by the kind of method that gave the number. */
      sure: {
        exact: "This network has an exact solution, so these numbers are certain for the model as drawn.",
        simulation: "The numbers come from a simulation, so each has a 95 % interval: the true value is very likely inside it.",
        approximation: "The numbers come from an approximation: a good estimate, to be checked with a second method.",
        diffusion: "The numbers come from a diffusion model, an approximation that is best when stations are busy: check it with a second method.",
        bound: "This method gives bounds, not estimates: the true value lies between them.",
        mixed: "Several methods contributed to these numbers.",
      } satisfies Record<Tier, string>,
      where: "The same numbers are beside each station on the canvas and in the Results pane.",
    },
    check: {
      title: "Check with another method",
      text: "Press “Check with …” in the Results pane (or Run ▸ Check with Another Method). A second, independent method works out the same quantities, and Qnet compares the two.",
    },
  },

  finish: {
    title: "Your first model is built and checked",
    /** What the comparison says, by the Agreement view's verdict. */
    verdict: {
      exact: "The second method was measured against the exact result. Where it lands close, you have seen how good that method is on a network like this one.",
      agree: "The two methods agree: they are within 2 % of each other, so you can rely on these numbers.",
      close: "The two methods are close: within 10 % of each other. The numbers are a fair guide, not yet a firm answer.",
      disagree: "The two methods disagree by more than 10 %. Treat the numbers with care and run a simulation to settle it.",
      single: "Only one method has reported so far, so there is nothing to compare it with yet.",
    } satisfies Record<Verdict, string>,
    /** The same, when one of the two is exact: the comparison then measures the other method. */
    withExact: {
      agree: "The second method agrees with the exact result (within 2 %). On a network like this one, either could be relied on.",
      close: "The second method is within 10 % of the exact result. Trust the exact numbers: the gap shows how far the other method can be off here.",
      disagree: "The second method is more than 10 % from the exact result. Trust the exact numbers: the other method does not suit this network.",
    },
    meaning: "Agreement is how Qnet shows how sure to be: when methods that work in different ways reach the same numbers, the answer can be trusted.",
    nextHeading: "Three things to try next",
    sweep: "What-If Sweep",
    sweepHelp: "Change one rate over a range and watch the queues respond",
    example: "Open an Example",
    exampleHelp: "Networks from the research literature, ready to solve",
    chooser: "Method Chooser",
    chooserHelp: "See every method that fits this network, and why",
    close: "Finish",
    closeHelp: "Close the tour",
  },
} as const;

/** The step titles and texts in order, as the callout prints them for the tour's own network (the report and the tests quote these). */
export const STEP_ORDER: StepId[] = ["source", "stations", "sink", "link", "rate", "solve", "read", "check"];
