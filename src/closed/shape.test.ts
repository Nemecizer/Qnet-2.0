// The interface's closed-network rule (shape.ts) against the cases core is checked on
// (shape.fixtures.json; the Rust side is `the_interface_and_core_agree_on_what_is_closed`).
import { describe, expect, it } from "vitest";
import { drawnAs, openOnly } from "./shape";
import fixtures from "./shape.fixtures.json";

const examples = import.meta.glob("../../examples/**/*.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

type Doc = { nodes: { id: string; kind: string }[]; links: { fromNodeID: string }[]; closedPopulation?: number | null };

describe("closed or open: the one rule", () => {
  for (const f of fixtures) {
    it(f.name, () => {
      const doc = JSON.parse(examples[`../../examples/${f.example}.bnet`]) as Doc;
      doc.nodes = doc.nodes.filter((n) => !(f.dropKinds as string[]).includes(n.kind));
      if (f.dropLinks) doc.links = [];
      if (f.population === null) delete doc.closedPopulation;
      else if (typeof f.population === "number") doc.closedPopulation = f.population;
      expect(drawnAs(doc)).toBe(f.drawn);
      expect(openOnly(doc, "Capacity planning")?.sentence ?? null).toBe(f.sentence);
      expect(openOnly(doc, "Capacity planning")?.reason ?? "open").toBe(f.drawn);
    });
  }
});
