// The five archetypes the gallery offers, in catalogue order (0.90.34
// `NetworkArchetypeBuilder.blueprints`; core/src/generate/archetypes.rs `BLUEPRINTS` builds them).
// The words are 0.90.34's; builder.test.ts checks them against
// golden/generators/archetype-catalogue.txt, which core is checked against too.
import type { ArchetypeRequest } from "../../lib/types";

export type ArchetypeKind = ArchetypeRequest["kind"];
export type Knob = "stations" | "servers" | "targetRho" | "feedbackProbability" | "buffers" | "arrivalRate";

export interface Blueprint {
  id: ArchetypeKind;
  group: string;
  title: string;
  /** The route in one line. */
  subtitle: string;
  knobs: readonly Knob[];
}

export const BLUEPRINTS: readonly Blueprint[] = [
  { id: "mmcStation", group: "Single Station", title: "M/M/c Station", subtitle: "Src1 → B1 → S1 → Sink1, with c parallel servers", knobs: ["servers", "targetRho", "arrivalRate", "buffers"] },
  { id: "tandemLine", group: "Lines", title: "Tandem Line", subtitle: "Src1 → B1 → S1 → … → Sd → Sink1, every station at the same ρ", knobs: ["stations", "servers", "targetRho", "arrivalRate", "buffers"] },
  { id: "forkStyleSplit", group: "Lines", title: "Fork and Merge", subtitle: "S1 splits its output evenly into S2 and S3, both to Sink1", knobs: ["servers", "targetRho", "arrivalRate", "buffers"] },
  {
    id: "openJacksonFeedback",
    group: "Feedback",
    title: "Line with Rework",
    subtitle: "Every station returns a fraction p of its output to its own buffer",
    knobs: ["stations", "servers", "targetRho", "feedbackProbability", "arrivalRate", "buffers"],
  },
  { id: "reentrantTwoStation", group: "Feedback", title: "Re-entrant Pair", subtitle: "S1 → S2, and S2 sends a fraction p back to B1 — a two-station cycle", knobs: ["servers", "targetRho", "feedbackProbability", "arrivalRate", "buffers"] },
];

/** Section order, derived from the catalogue: Single Station, Lines, Feedback. */
export const GROUPS: readonly string[] = BLUEPRINTS.map((b) => b.group).filter((g, i, all) => all.indexOf(g) === i);

export function blueprint(id: ArchetypeKind): Blueprint {
  return BLUEPRINTS.find((b) => b.id === id) ?? BLUEPRINTS[0];
}

export const uses = (b: Blueprint, k: Knob) => b.knobs.includes(k);

/** The tile the gallery opens on. */
export const DEFAULT_ARCHETYPE: ArchetypeKind = "tandemLine";

/** 0.90.34 `ArchetypeParameters`' ranges. */
export const RANGES = {
  stations: [1, 12],
  servers: [1, 16],
  rho: [0.05, 0.99],
  feedback: [0.0, 0.9],
  capacity: [1, 500],
  arrivalRate: [0.001, 1000.0],
} as const;
