// The one rule about the model features new in 2.1 — priority service at a station, batch
// arrivals at a source, a time-varying arrival rate at a source — as the interface needs it
// before any command has answered: which features a document uses, and the sentence a method or
// analysis that reads a network the classical way says of it. It mirrors core/src/extended.rs
// (`node_uses`, `features`, `refusal_except`, `classical_only`) exactly; both are checked on the
// cases of shape.fixtures.json (shape.test.ts here, and
// `the_interface_and_core_agree_on_the_new_features` in src-tauri/src/live.rs).
import { openOnly } from "../closed/shape";

export type Feature = "priorities" | "batchArrivals" | "timeVaryingRates";
export const FEATURES: readonly Feature[] = ["priorities", "batchArrivals", "timeVaryingRates"];

type ShapeNode = { id?: string; kind: string; name?: string; serviceDiscipline?: string | null; batchSize?: unknown; rateProfile?: unknown };
type Shape = { nodes?: readonly ShapeNode[]; links?: readonly { fromNodeID: string }[]; closedPopulation?: number | null };

/** Core `node_uses`: what the file says, never a judgement about values. */
export function nodeUses(n: ShapeNode, feature: Feature): boolean {
  if (feature === "priorities") return n.kind === "station" && typeof n.serviceDiscipline === "string" && n.serviceDiscipline !== "fcfs";
  if (feature === "batchArrivals") return n.kind === "source" && n.batchSize !== undefined && n.batchSize !== null;
  return n.kind === "source" && n.rateProfile !== undefined && n.rateProfile !== null;
}

/** Core `features`: each feature in use with the names of its nodes, in document order. */
export function featuresOf(doc: Shape | null | undefined): { feature: Feature; nodes: string[] }[] {
  const nodes = doc?.nodes ?? [];
  return FEATURES.map((feature) => ({ feature, nodes: nodes.filter((n) => nodeUses(n, feature)).map((n) => n.name ?? "") })).filter((f) => f.nodes.length > 0);
}

export const usesFeature = (doc: Shape | null | undefined, feature: Feature) => (doc?.nodes ?? []).some((n) => nodeUses(n, feature));
export const usesAnyFeature = (doc: Shape | null | undefined) => FEATURES.some((f) => usesFeature(doc, f));

const PHRASE: Record<Feature, string> = { priorities: "priority service", batchArrivals: "batch arrivals", timeVaryingRates: "a time-varying arrival rate" };

/** Core `refusal_except`: the sentence, or null when the document uses none of the features not in `modelled`. */
export function refusal(doc: Shape | null | undefined, analysis: string, modelled: readonly Feature[] = []): string | null {
  const used = featuresOf(doc).filter((f) => !modelled.includes(f.feature));
  if (used.length === 0) return null;
  const what = used.map((f) => `${PHRASE[f.feature]} at ${f.nodes.join(", ")}`).join(" and ");
  const advice = used.some((f) => f.feature === "timeVaryingRates")
    ? "A network whose arrival rate changes in time has no single steady state: the Transient view computes how it moves, and Run ▸ Animate shows it."
    : "Replicated Simulation models it, and so does the exact single-station formula where it applies.";
  return `This network uses ${what}. ${analysis} does not model that, and would answer for a different network. ${advice}`;
}

/** Core `classical_only`: the closed rule first, then this one. */
export function classicalOnly(doc: Shape | null | undefined, analysis: string): { reason: "closed" | "closedNoPopulation" | "extended"; sentence: string } | null {
  const closed = openOnly(doc, analysis);
  if (closed) return closed;
  const sentence = refusal(doc, analysis);
  return sentence === null ? null : { reason: "extended", sentence };
}
