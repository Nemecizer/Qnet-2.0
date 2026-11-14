// What the interface needs to know about a batch law or a rate profile to show it: their means
// and a description. The arithmetic that matters (loads, formulas, simulation) is core's
// (core/src/model.rs `BatchSize`, `RateProfile`); these are the same three one-line moments, kept
// here only so a field can say "mean batch size 2.5" as it is typed.
import type { BatchSize, BnetNode, RateProfile } from "../lib/bnet";
import { classLabel } from "../editor";
import { formatSig } from "../editor/numbers";
import { extendedWords as w } from "./words";
import type { Feature } from "./shape";
import { nodeUses } from "./shape";

/** core `BatchSize::mean`. */
export function batchMean(b: BatchSize): number {
  if (b.kind === "constant") return b.size;
  if (b.kind === "geometric") return b.mean;
  return b.probabilities.reduce((sum, p, i) => sum + (i + 1) * p, 0);
}

/** core `BatchSize::problem`, as yes or no. */
export function batchIsValid(b: BatchSize): boolean {
  if (b.kind === "constant") return Number.isInteger(b.size) && b.size >= 1;
  if (b.kind === "geometric") return Number.isFinite(b.mean) && b.mean >= 1;
  return b.probabilities.length > 0 && b.probabilities.every((p) => Number.isFinite(p) && p >= 0) && Math.abs(b.probabilities.reduce((s, p) => s + p, 0) - 1) <= 1e-9;
}

/** core `RateProfile::long_run_mean`. */
export function profileMean(r: RateProfile): number {
  if (!r.periodic) return 1;
  let last = 0;
  let area = 0;
  for (const s of r.segments) {
    area += (s.until - last) * s.multiplier;
    last = s.until;
  }
  return last > 0 ? area / last : 1;
}

/** The index (1-based) of the first segment core's `RateProfile::problem` would name, and which rule it breaks. */
export function profileProblem(r: RateProfile): { segment: number; what: "length" | "multiplier" } | null {
  let last = 0;
  for (let i = 0; i < r.segments.length; i++) {
    const s = r.segments[i];
    if (!(Number.isFinite(s.until) && s.until > last)) return { segment: i + 1, what: "length" };
    if (!(Number.isFinite(s.multiplier) && s.multiplier >= 0)) return { segment: i + 1, what: "multiplier" };
    last = s.until;
  }
  return null;
}

/** The features a node uses, with the words the canvas mark and the outline say. */
export function nodeFeatures(n: BnetNode): { feature: Feature; glyph: string; label: string; outline: string }[] {
  const out: { feature: Feature; glyph: string; label: string; outline: string }[] = [];
  if (nodeUses(n, "priorities")) {
    const pre = n.serviceDiscipline === "priorityPreemptiveResume";
    out.push({ feature: "priorities", glyph: w.glyph.priorities, label: w.marks.priorities(pre), outline: w.outline.priorities(pre, (n.priorityOrder ?? []).map(classLabel).join(" > ")) });
  }
  if (nodeUses(n, "batchArrivals") && n.batchSize) out.push({ feature: "batchArrivals", glyph: w.glyph.batchArrivals, label: w.marks.batchArrivals, outline: w.outline.batchArrivals(formatSig(batchMean(n.batchSize), 4)) });
  if (nodeUses(n, "timeVaryingRates") && n.rateProfile) out.push({ feature: "timeVaryingRates", glyph: w.glyph.timeVaryingRates, label: w.marks.timeVaryingRates, outline: w.outline.timeVaryingRates(n.rateProfile.segments.length, n.rateProfile.periodic) });
  return out;
}

/**
 * One sentence for each feature a node uses, complete enough that a reader who sees nothing
 * else cannot take the network for a plain one (the assistant's description of the network,
 * src/panes/ai): the discipline and the whole order; the batch law and its mean; the profile's
 * pieces and its long-run mean. Empty for a node that uses none.
 */
export function featureSentences(n: BnetNode): string[] {
  const out: string[] = [];
  if (nodeUses(n, "priorities")) {
    const order = (n.priorityOrder ?? []).map(classLabel).join(", then ");
    out.push(w.said.priorities(n.name, n.serviceDiscipline === "priorityPreemptiveResume", order));
  }
  if (nodeUses(n, "batchArrivals") && n.batchSize) {
    const b = n.batchSize;
    const law = b.kind === "constant" ? `always ${b.size}` : b.kind === "geometric" ? `geometric with mean ${formatSig(b.mean, 4)}` : `sizes 1 to ${b.probabilities.length} with probabilities ${b.probabilities.map((p) => formatSig(p, 4)).join(", ")}`;
    out.push(w.said.batchArrivals(n.name, law, formatSig(batchMean(b), 4)));
  }
  if (nodeUses(n, "timeVaryingRates") && n.rateProfile) {
    const r = n.rateProfile;
    let from = 0;
    const pieces = r.segments.map((s) => {
      const piece = `×${formatSig(s.multiplier, 4)} from time ${formatSig(from, 4)} to ${formatSig(s.until, 4)}`;
      from = s.until;
      return piece;
    });
    out.push(w.said.timeVaryingRates(n.name, pieces.join("; "), r.periodic, formatSig(profileMean(r), 4)));
  }
  return out;
}
