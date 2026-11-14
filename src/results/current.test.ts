// A change of layout alone does not make a run stale (ledger RES-050, Changed in 2.1).
import { beforeEach, describe, expect, it } from "vitest";
import type { ResultRecord } from "../panes/results/model";
import { isStale } from "../panes/results/model";
import { noteStructure, resetStructures, sameNetwork, structureKey } from "./current";
import { currentRuns } from "./insight";

const raw = import.meta.glob("../../golden/runs/5stationtandem.inf/qna/record.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const run = JSON.parse(Object.values(raw)[0]) as ResultRecord;
const snapshot = run.provenance.networkSnapshot as { nodes: Record<string, unknown>[]; links: Record<string, unknown>[]; infiniteBuffers: boolean };
const moved = { ...snapshot, nodes: snapshot.nodes.map((n, i) => (i === 0 ? { ...n, position: [400, 400], picture: "star" } : n)).reverse() };
const faster = { ...snapshot, nodes: snapshot.nodes.map((n) => (n.kind === "station" ? { ...n, distributionParameters: "rate=2.0" } : n)) };

beforeEach(() => resetStructures());

describe("a run and the network as it is now", () => {
  it("is current for its own fingerprint, with nothing noted", () => {
    expect(sameNetwork(run, run.provenance.networkFingerprint)).toBe(true);
    expect(sameNetwork(run, "moved-fp")).toBe(false);
  });

  it("stays current when nodes are only moved, restyled or reordered", () => {
    expect(structureKey(moved)).toBe(structureKey(snapshot));
    noteStructure("moved-fp", moved);
    expect(sameNetwork(run, "moved-fp")).toBe(true);
    expect(isStale(run, "moved-fp")).toBe(false);
    expect(currentRuns([run], "moved-fp")).toHaveLength(1);
  });

  it("is stale once anything a solver reads changes: a rate, a link, the buffer mode", () => {
    noteStructure("faster-fp", faster);
    expect(isStale(run, "faster-fp")).toBe(true);
    expect(currentRuns([run], "faster-fp")).toEqual([]);
    expect(structureKey({ ...snapshot, links: snapshot.links.slice(1) })).not.toBe(structureKey(snapshot));
    expect(structureKey({ ...snapshot, infiniteBuffers: !snapshot.infiniteBuffers })).not.toBe(structureKey(snapshot));
  });
});
