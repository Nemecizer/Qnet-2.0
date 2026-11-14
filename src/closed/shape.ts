// The one rule that tells a closed network from an open one, as the interface needs it before any
// command has answered. It mirrors core/src/closed.rs (`looks_closed`, `drawn_as`, `open_only`)
// exactly; both are checked on the cases of shape.fixtures.json (shape.test.ts here, and
// `the_interface_and_core_agree_on_what_is_closed` in src-tauri/src/live.rs).

type Shape = { nodes?: readonly { id?: string; kind: string }[]; links?: readonly { fromNodeID: string }[]; closedPopulation?: number | null };

/** "open", or drawn as a closed network: with its population ("closed") or without one yet. */
export type Drawn = "open" | "closed" | "closedNoPopulation";

/** Drawn as a closed network: stations, no source and no sink (core `looks_closed`). */
export const looksClosed = (nodes: readonly { kind: string }[]) => nodes.some((n) => n.kind === "station") && !nodes.some((n) => n.kind === "source" || n.kind === "sink");

/** Core `drawn_as`. A population on a network with a source or a sink is ignored; a lone station is a network being started. */
export function drawnAs(doc: Shape | null | undefined): Drawn {
  const nodes = doc?.nodes ?? [];
  if (!looksClosed(nodes)) return "open";
  if (doc?.closedPopulation !== undefined && doc?.closedPopulation !== null) return "closed";
  const stations = new Set(nodes.filter((n) => n.kind === "station").map((n) => n.id));
  return (doc?.links ?? []).some((l) => stations.has(l.fromNodeID)) ? "closedNoPopulation" : "open";
}

export const NO_POPULATION = "The network has no source and no sink, but no number of customers is set. Set the population to make it a closed network.";

/** Core `open_only`: what an analysis of open networks says of a network drawn closed, or null. */
export function openOnly(doc: Shape | null | undefined, analysis: string): { reason: "closed" | "closedNoPopulation"; sentence: string } | null {
  const reason = drawnAs(doc);
  if (reason === "open") return null;
  return {
    reason,
    sentence:
      reason === "closed"
        ? `This is a closed network: a fixed number of customers circulates and nothing arrives from outside. ${analysis} covers open networks.`
        : `${NO_POPULATION} ${analysis} covers open networks, which have a source and a sink.`,
  };
}
