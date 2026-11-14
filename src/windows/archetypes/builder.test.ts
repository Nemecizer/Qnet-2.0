// The preview's archetype builder (src/dev/mock/archetypes.ts) and the gallery's catalogue against
// 0.90.34's own (golden/generators, ledger GEN-031…041): every network ids aside, every summary,
// and the catalogue's words. The app builds in Rust (core, checked against the same files); this
// copy makes the mock exact, so golden/edits/archetype-insert replays in Vitest.
import { describe, expect, it } from "vitest";
import { archetypeSummary, buildArchetypeDocument, cG, rateLiteral } from "../../dev/mock/archetypes";
import type { BnetDocument } from "../../lib/bnet";
import type { ArchetypeRequest } from "../../lib/types";
import { BLUEPRINTS, GROUPS, type ArchetypeKind } from "./catalogue";

const golden = import.meta.glob("../../../golden/generators/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const file = (name: string) => golden[`../../../golden/generators/${name}`];
const names = Object.keys(golden).map((k) => k.slice(k.lastIndexOf("/") + 1));

/** "archetype-<id>-<setting>-d3-c1-rho0.9-p0.3-inf-lambda1.0.bnet" → the request it was built with. */
function requestOf(name: string): { inserted: boolean; request: ArchetypeRequest } {
  const m = /^(archetype|built)-(\w+)-\w+-d(-?\d+)-c(-?\d+)-rho([\d.]+)-p(-?[\d.]+)-(inf|finite(-?\d+))-lambda([\d.]+)\.bnet$/.exec(name)!;
  return {
    inserted: m[1] === "archetype",
    request: {
      kind: m[2] as ArchetypeKind,
      stations: Number(m[3]),
      servers: Number(m[4]),
      targetRho: Number(m[5]),
      feedbackProbability: Number(m[6]),
      infiniteBuffers: m[7] === "inf",
      bufferCapacity: m[8] !== undefined ? Number(m[8]) : 10,
      arrivalRate: Number(m[9]),
    },
  };
}

/** A document with its ids replaced by their order of first appearance, as the Rust golden test compares. */
function withoutIds(doc: BnetDocument): unknown {
  const ids = new Map<string, string>();
  const id = (x: string) => {
    if (!ids.has(x)) ids.set(x, `#${ids.size}`);
    return ids.get(x)!;
  };
  doc.nodes.forEach((n) => id(n.id));
  return {
    ...doc,
    nodes: doc.nodes.map((n) => ({ ...n, id: id(n.id) })),
    links: doc.links.map((l) => ({ ...l, id: id(l.id), fromNodeID: id(l.fromNodeID), toNodeID: id(l.toNodeID) })),
  };
}

/** `archetype_as_inserted`: moved so its top-left corner is at (80, 220) (renaming is a no-op: built in node order). */
function asInserted(doc: BnetDocument): BnetDocument {
  const minX = Math.min(...doc.nodes.map((n) => n.position[0]));
  const minY = Math.min(...doc.nodes.map((n) => n.position[1]));
  return { ...doc, nodes: doc.nodes.map((n) => ({ ...n, position: [n.position[0] + 80 - minX, n.position[1] + 220 - minY] })) };
}

describe("the catalogue and the builder are 0.90.34's", () => {
  it("lists the five archetypes in three groups with 0.90.34's titles, routes and knobs (GEN-031…035)", () => {
    const lines = file("archetype-catalogue.txt").trim().split("\n");
    expect(lines[0]).toBe(`groups: ${GROUPS.join(" | ")}`);
    expect(lines.slice(1)).toEqual(BLUEPRINTS.map((b) => [b.id, b.group, b.title, b.subtitle, b.knobs.join(",")].join(" | ")));
  });

  it("the preview builds every golden archetype exactly, ids aside (45 networks)", () => {
    const cases = names.filter((n) => /^(archetype|built)-.*\.bnet$/.test(n));
    expect(cases).toHaveLength(45);
    for (const name of cases) {
      const { inserted, request } = requestOf(name);
      let n = 0;
      const built = buildArchetypeDocument(request, () => `id-${++n}`);
      const mine = inserted ? asInserted(built) : built;
      expect(withoutIds(mine), name).toEqual(withoutIds(JSON.parse(file(name))));
    }
  });

  it("writes 0.90.34's summary for every golden setting (40 lines)", () => {
    const lines = file("archetype-summaries.txt").trim().split("\n");
    expect(lines).toHaveLength(40);
    for (const line of lines) {
      const [name, want] = line.split("\t");
      expect(archetypeSummary(requestOf(name).request), name).toBe(want);
    }
  });

  it("formats rates as %.8g with a .0 when there is no point (rateLiteral)", () => {
    expect(rateLiteral(1)).toBe("1.0");
    expect(rateLiteral(1 / 0.9)).toBe("1.1111111");
    expect(rateLiteral(1000 / (0.05 * 1))).toBe("20000.0");
    expect(rateLiteral(0.001 / (0.99 * 16))).toBe("6.3131313e-05");
    expect(cG(123456789, 8)).toBe("1.2345679e+08");
  });
});
