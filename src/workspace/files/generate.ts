// Network ▸ Generate Random Network's validation and its new tab (ledger GEN-002…011, WS-033,
// WS-126): 0.90.34's `GenerateRandomNetworkSheet` rules and `createRandomNetworkTab`. The
// generator and the Status lines' numbers are Rust's (core/src/generate, files.rs).
import { api } from "../../lib/api";
import { parseDocument } from "../../lib/bnet";
import { report } from "../../lib/dialogs";
import type { GenerateRequest } from "../../lib/types";
import { addStatus, addTab, getWorkspace } from "../store";
import { reasonOf } from "./documents";
import { inferSeverity } from "./status";
import { fileWords as w } from "./words";

export type Topology = GenerateRequest["topology"];

export interface RandomForm {
  stations: string;
  classes: string;
  infiniteBuffers: boolean;
  topology: Topology;
  rho: string;
  seed: string;
}

/** The sheet's defaults: 4 stations, 3 classes, infinite buffers, feed-forward, ρ "0.90", no seed. */
export const RANDOM_DEFAULTS: RandomForm = { stations: "4", classes: "3", infiniteBuffers: true, topology: "feedForward", rho: "0.90", seed: "" };

/** `DS.Number.parseInt`: a whole number, or null. */
export function parseWhole(text: string): number | null {
  const t = text.trim();
  if (!/^[+-]?\d{1,3}(,\d{3})*$|^[+-]?\d+$/.test(t)) return null;
  return Number(t.replace(/,/g, ""));
}

/** `DS.Number.parse`: the canonical form ("0.9", "9e-1"), or a decimal comma ("0,9"). */
export function parseNumber(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const canonical = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
  if (canonical.test(t)) return Number(t);
  // One comma, no period, and not the three digits of a grouped thousand: a decimal comma.
  const parts = t.split(",");
  if (parts.length === 2 && !t.includes(".") && /^\d+$/.test(parts[1]) && parts[1].length !== 3 && canonical.test(`${parts[0]}.${parts[1]}`)) return Number(`${parts[0]}.${parts[1]}`);
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d*)?$/.test(t)) return Number(t.replace(/,/g, ""));
  return null;
}

const U64_MAX = 18446744073709551615n;

/** `UInt64(text)` after trimming spaces: blank is "no seed" (undefined), a bad value null. */
export function parseSeed(text: string): string | undefined | null {
  const t = text.replace(/^[ \t]+|[ \t]+$/g, "");
  if (!t) return undefined;
  if (!/^\+?\d+$/.test(t)) return null;
  const digits = t.replace(/^\+/, "");
  return BigInt(digits) <= U64_MAX ? digits : null;
}

/** The first blocking problem, in 0.90.34's order (GEN-002…007), or null. */
export function randomProblem(f: RandomForm): string | null {
  const s = parseWhole(f.stations);
  if (s === null || s < 1 || s > 20) return w.stationsProblem;
  const c = parseWhole(f.classes);
  if (c === null || c < 1 || c > 8) return w.classesProblem;
  const rho = parseNumber(f.rho);
  if (rho === null || !Number.isFinite(rho) || rho < 0.1 || rho > 0.99) return w.rhoProblem;
  if (parseSeed(f.seed) === null) return w.seedProblem;
  return null;
}

/** "Random N": one more than the highest "Random N" tab now open (WS-033, GEN-009). */
export function nextRandomTitle(): string {
  const numbers = getWorkspace()
    .tabs.map((t) => (t.title.startsWith("Random ") ? t.title.slice(7) : null))
    .filter((n): n is string => n !== null && /^[+-]?\d+$/.test(n))
    .map(Number);
  return w.randomTabTitle((numbers.length ? Math.max(...numbers) : 0) + 1);
}

/** Generate: a new active tab "Random N" with the network, unsaved (WS-126), and its Status lines. */
export async function generateRandomNetwork(f: RandomForm): Promise<string | null> {
  if (randomProblem(f)) return null;
  const title = nextRandomTitle();
  try {
    const g = await api.networkGenerate({
      stations: parseWhole(f.stations)!,
      classes: parseWhole(f.classes)!,
      infiniteBuffers: f.infiniteBuffers,
      targetRho: parseNumber(f.rho)!,
      topology: f.topology,
      seed: parseSeed(f.seed) ?? null,
      title,
    });
    const id = addTab({ title, document: parseDocument(g.text), revision: 1, savedRevision: 0 });
    for (const line of g.lines) addStatus(line.text, line.severity ?? inferSeverity(line.text), id);
    return id;
  } catch (e) {
    const r = reasonOf(e);
    await report({ title: w.generateFailedTitle, message: r.message, details: r.detail });
    return null;
  }
}
