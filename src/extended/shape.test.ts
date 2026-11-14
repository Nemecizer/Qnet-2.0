// The interface's rule about the new model features (shape.ts) against the cases core is checked
// on (shape.fixtures.json; the Rust side is `the_interface_and_core_agree_on_the_new_features`).
import { describe, expect, it } from "vitest";
import { classicalOnly, featuresOf, refusal, usesAnyFeature } from "./shape";
import fixtures from "./shape.fixtures.json";

const examples = import.meta.glob("../../examples/**/*.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

type Doc = { nodes: ({ id: string; kind: string; name: string } & Record<string, unknown>)[]; links: { fromNodeID: string }[]; closedPopulation?: number | null };

describe("priorities, batch arrivals, rate profiles: the one rule", () => {
  for (const f of fixtures) {
    it(f.name, () => {
      const doc = JSON.parse(examples[`../../examples/${f.example}.bnet`]) as Doc;
      for (const [name, keys] of Object.entries(f.set as Record<string, Record<string, unknown>>)) {
        const node = doc.nodes.find((n) => n.name === name);
        expect(node, name).toBeDefined();
        Object.assign(node!, keys);
      }
      expect(featuresOf(doc).map((x) => x.feature)).toEqual(f.features);
      expect(usesAnyFeature(doc)).toBe(f.features.length > 0);
      const said = classicalOnly(doc, "Capacity planning");
      expect(said?.reason ?? null).toBe(f.reason);
      expect(said?.sentence ?? null).toBe(f.sentence);
    });
  }

  it("an analysis that models a feature names only the others", () => {
    const doc = JSON.parse(examples["../../examples/extended/RushHour.mt-m-2.daily.bnet"]) as Doc;
    expect(refusal(doc, "Transient analysis", ["timeVaryingRates"])).toBeNull();
    Object.assign(doc.nodes.find((n) => n.name === "Src1")!, { batchSize: { kind: "constant", size: 2 } });
    expect(refusal(doc, "Transient analysis", ["timeVaryingRates"])).toBe("This network uses batch arrivals at Src1. Transient analysis does not model that, and would answer for a different network. Replicated Simulation models it, and so does the exact single-station formula where it applies.");
  });
});
