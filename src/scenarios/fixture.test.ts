// The interface's override rules against the files core's are held to (ledger WF-503):
// core/tests/fixtures/scenarios/ holds one file with scenarios and that file saved showing each
// variant, written by Rust (`qnet-cli resave --scenario`, core/src/scenarios.rs).
// core/tests/scenarios_fixture.rs checks Rust against them; this checks TypeScript, so
// `qnet-cli --scenario`, Python's `Network.open(path, scenario=…)` and the app read one network.
import { describe, expect, it } from "vitest";
import type { BnetDocument } from "../lib/bnet";
import { documentSignature } from "../workspace/store";
import { activeId, canonicalScenarios, plain, scenarioDocument, scenariosOf, switchScenario } from "./model";

const files = import.meta.glob("../../core/tests/fixtures/scenarios/*.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const read = (name: string) => JSON.parse(files[`../../core/tests/fixtures/scenarios/${name}.bnet`]) as BnetDocument;
const golden = import.meta.glob("../../golden/OpenJackson.d2.feedback.p30.inf/resave.bnet", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const VARIANTS: [name: string | null, file: string][] = [
  [null, "shown-baseline"],
  ["Peak hour", "shown-peak-hour"],
  ["Add a server at S2", "shown-add-a-server-at-s2"],
];

describe("one file, read by Rust and by TypeScript (WF-503)", () => {
  const doc = read("feedback");
  const idOf = (name: string | null) => (name === null ? null : scenariosOf(doc).find((s) => s.name === name)!.id);

  it("each variant is the network Rust wrote for it", () => {
    expect(scenariosOf(doc).map((s) => s.name)).toEqual(["Peak hour", "Add a server at S2"]);
    expect(activeId(doc)).toBe(idOf("Peak hour"));
    for (const [name, file] of VARIANTS) expect(scenarioDocument(doc, idOf(name)), String(name)).toEqual(plain(read(file)));
    expect(scenarioDocument(doc, null)).toEqual(JSON.parse(Object.values(golden)[0]));
  });

  it("showing a variant gives the file Rust saves showing it: the same content, hence not an edit", () => {
    for (const [name, file] of VARIANTS) {
      const shown = switchScenario(doc, idOf(name));
      const expected = read(file);
      expect(plain(shown), String(name)).toEqual(plain(expected));
      expect(canonicalScenarios(shown.scenarios), String(name)).toEqual(canonicalScenarios(expected.scenarios));
      expect(documentSignature(shown), String(name)).toBe(documentSignature(expected));
    }
  });
});
