// The command line repeats the Method Chooser's rules in Rust (cli/src/methods.rs: `qnet-cli
// methods`, `qnet-cli solve`, and through them the Python package's `net.methods()` and
// `net.solve()`). This test holds the two together: for every example network, the rows
// `recommendations` builds from the fixture's domain, and Solve's choice over them, are what the
// command line printed into cli/tests/fixtures/methods.json (which cli/tests/cli_json.rs holds to
// the built tool, and src-tauri's advice.rs tests hold to the app's own `domain()`).
import { describe, expect, it } from "vitest";
import fixture from "../../../cli/tests/fixtures/methods.json";
import type { MethodDomain, RuntimeAvailability, RuntimeKey } from "../../lib/types";
import { candidates, runnable, solveChoice } from "../../panes/results/agreement/plan";
import { tierOf } from "../../results/insight";
import type { ResultRecord } from "../../panes/results/model";
import { recommendations } from "./advice";

interface Row { id: string; name: string; label: string | null; identifier: string | null; tier: string | null; fidelity: string | null; kind: string; layer: string; suitability: string; applicable: boolean; reason: string }
interface Case { example: string; domain: MethodDomain; methods: Row[]; solve: { label: string; name: string; why: string; reason: string } | null }

const cases = fixture as unknown as Case[];
const KEYS: RuntimeKey[] = ["productForm", "qbd", "regenerative", "truncatedCtmc", "adaptiveBar", "barBounds", "multiclass", "genericCtmc", "decomposition"];
const installed: RuntimeAvailability[] = KEYS.map((key) => ({ key, available: true, reason: null }));

describe("the command line's method rows are the Method Chooser's", () => {
  it("covers every example", () => {
    expect(cases.length).toBeGreaterThanOrEqual(51);
  });

  it.each(cases.map((c) => [c.example, c] as const))("%s", (_name, c) => {
    const rows = recommendations(c.domain, installed);
    const infinite = c.domain.infiniteBuffers;
    expect(c.methods.map((m) => [m.id, m.name, m.layer, m.suitability, m.reason])).toEqual(rows.map((r) => [r.id, r.name, r.layer, r.suitability, r.summary]));
    for (const [i, r] of rows.entries()) {
      const run = runnable(r, infinite);
      const said = c.methods[i];
      expect([said.label, said.identifier]).toEqual([run?.label ?? null, run?.identifier ?? null]);
      expect(said.applicable).toBe(r.suitability !== "unavailable");
      if (run) {
        expect(said.kind).toBe(run.kind);
        expect(said.tier).toBe(tierOf({ method: { fidelity: said.fidelity } } as unknown as ResultRecord));
      }
    }
    const pick = solveChoice(candidates(rows, infinite));
    expect(c.solve ? [c.solve.label, c.solve.why, c.solve.name] : null).toEqual(pick ? [pick.candidate.label, pick.why, pick.candidate.advice.name] : null);
  });
});
