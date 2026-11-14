// What an example card says about a network, read from its file and nothing else: the counts,
// the buffer regime, and the shape of its routing. No name, citation or difficulty is guessed.
import type { BnetDocument } from "../lib/bnet";
import { drawnAs, type Drawn } from "../closed/shape";
import { welcomeWords as w, type ExampleFilter, type ExampleShape } from "./words";
import { featuresOf, type Feature } from "../extended/shape";

export interface ExampleFacts {
  stations: number;
  classes: number;
  infinite: boolean;
  shape: ExampleShape;
  multiServer: boolean;
  /** A closed network's number of circulating customers; null for an open network. */
  population: number | null;
  /** The model features new in 2.1 the network uses (src/extended/shape.ts): priorities, batch arrivals, a rate profile. */
  features: Feature[];
}

/** The Editor's `numberOfCustomerClasses`: the sources, or the highest class a link names, whichever is more. */
export function classCount(doc: Pick<BnetDocument, "nodes" | "links">): number {
  let n = doc.nodes.filter((x) => x.kind === "source").length;
  for (const l of doc.links) n = Math.max(n, l.customerClass + 1, (l.toCustomerClass ?? -1) + 1);
  return n;
}

/** Whether the links, as a directed graph over the nodes, contain a cycle (a self-loop counts). */
export function hasCycle(doc: Pick<BnetDocument, "nodes" | "links">): boolean {
  const out = new Map<string, string[]>();
  for (const l of doc.links) {
    if (l.fromNodeID === l.toNodeID) return true;
    const list = out.get(l.fromNodeID);
    if (list) list.push(l.toNodeID);
    else out.set(l.fromNodeID, [l.toNodeID]);
  }
  // Iterative three-colour depth-first search.
  const state = new Map<string, 1 | 2>();
  for (const start of out.keys()) {
    if (state.has(start)) continue;
    const stack: [string, number][] = [[start, 0]];
    state.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const next = out.get(top[0])?.[top[1]++];
      if (next === undefined) {
        state.set(top[0], 2);
        stack.pop();
      } else if (state.get(next) === 1) return true;
      else if (!state.has(next)) {
        state.set(next, 1);
        stack.push([next, 0]);
      }
    }
  }
  return false;
}

/**
 * `drawn` is Rust's word for the file (`examples_list`, core's `closed::drawn_as`); without it the
 * interface's copy of the same rule answers (src/closed/shape.ts).
 */
export function factsOf(doc: BnetDocument, drawn: Drawn = drawnAs(doc)): ExampleFacts {
  const stations = doc.nodes.filter((n) => n.kind === "station");
  const classChange = doc.links.some((l) => l.toCustomerClass !== undefined && l.toCustomerClass !== l.customerClass);
  const cyclic = hasCycle(doc);
  // A line: nothing returns, no node sends one class to two places…
  const fanOut = new Map<string, Set<string>>();
  for (const l of doc.links) {
    const key = `${l.fromNodeID}|${l.customerClass}`;
    if (!fanOut.has(key)) fanOut.set(key, new Set());
    fanOut.get(key)!.add(l.toNodeID);
  }
  const splits = [...fanOut.values()].some((s) => s.size > 1);
  // …and every class passes through every station.
  const stationIds = new Set(stations.map((s) => s.id));
  const visited = new Map<number, Set<string>>();
  for (const l of doc.links) {
    if (!visited.has(l.customerClass)) visited.set(l.customerClass, new Set());
    for (const id of [l.fromNodeID, l.toNodeID]) if (stationIds.has(id)) visited.get(l.customerClass)!.add(id);
  }
  const everyClassEverywhere = visited.size > 0 && [...visited.values()].every((s) => s.size === stationIds.size);
  const line = !splits && everyClassEverywhere;
  // A closed network is said to be one: its routing is a cycle by nature, not "feedback".
  const population = drawn === "closed" && typeof doc.closedPopulation === "number" ? doc.closedPopulation : null;
  const shape: ExampleShape = population !== null ? "closed" : classChange ? "reentrant" : cyclic ? "feedback" : !line ? "forward" : stations.length <= 1 ? "single" : "tandem";
  return { stations: stations.length, classes: classCount(doc), infinite: doc.infiniteBuffers, shape, multiServer: stations.some((s) => s.numberOfServers > 1), population, features: featuresOf(doc).map((f) => f.feature) };
}

/** "2 stations · 1 customer class · infinite buffers. Stations in a row: …" */
export function describe(f: ExampleFacts): string {
  const counts = [w.stations(f.stations), f.population !== null ? w.circulating(f.population) : w.classes(f.classes), w.buffers(f.infinite)].join(" · ");
  return `${counts}. ${w.shape[f.shape]}${f.multiServer ? ` ${w.multiServer}` : ""}${f.features.map((x) => ` ${w.features[x]}`).join("")}`;
}

export function matchesFilter(f: ExampleFacts, filter: ExampleFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "tandem":
      return f.shape === "tandem";
    case "feedback":
      return f.shape === "feedback" || f.shape === "reentrant";
    case "closed":
      return f.shape === "closed";
    case "multiclass":
      return f.classes > 1;
    case "finite":
      return !f.infinite;
  }
}

/** Every word of `query` appears in the name or the description (case-insensitive). */
export function matchesQuery(name: string, description: string, query: string): boolean {
  const hay = `${name} ${description}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => hay.includes(word));
}
