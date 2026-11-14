// The distribution families and the inspector's editing arithmetic (ledger 4.13, 4.14).
export * from "./families";
export * from "./draft";
export * from "./numbers";
import { asDistribution, card } from "./families";
import { compactSummary, makeDraft } from "./draft";

/**
 * A law in one line, for node labels and tooltips: "Gamma(k=2, θ=0.5)", the form the inspector's
 * Status summaries use (`<Family>(<compact summary>)`, five significant digits).
 */
export function lawDescription(distribution: string, parameters: string): string {
  const d = asDistribution(distribution);
  return `${card(d).displayName}(${compactSummary(makeDraft(d, parameters))})`;
}
