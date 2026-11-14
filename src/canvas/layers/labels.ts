// What a node says about itself: the label block's detail and rate rows, the spoken description
// (VoiceOver and the tooltip) and the ρ badge's words (0.90.34 NetworkCanvasLayers.swift
// `NetworkNodeView.detailText`, `rateText`, `rateDescription`, `accessibilityDescription`,
// `tooltipDescription`, `utilisationBadge`; Models.swift `QueueDistribution.computeMean`,
// `computeSCV`, `parseParameterStrings`; ledger CAN-031, CAN-032, CAN-156, CAN-158, CAN-200).
import { nodeFeatures } from "../../extended/model";
import type { BnetNode } from "../../lib/bnet";
import { distributionDisplayName } from "../../editor/distributions";
import { KIND_NAMES } from "../../editor/editor";
import { formatSig } from "../../editor/numbers";
import { canvasWords as w } from "../words";

/** `QueueDistribution.parseParameterStrings`: "k=v,k=v", a pair kept only when it splits into exactly two. */
export function parseParameterStrings(s: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of s.split(",")) {
    if (!pair) continue;
    const parts = pair.split("=").filter((p) => p.length > 0);
    if (parts.length === 2) out.set(parts[0].trim(), parts[1].trim());
  }
  return out;
}

/** Swift's `Double(String)`: a decimal or hexadecimal float, inf / infinity / nan; nothing else. */
export function swiftDouble(s: string): number | null {
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s);
  if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(s)) return NaN;
  if (/^[+-]?0x[0-9a-f]+(\.[0-9a-f]*)?(p[+-]?\d+)?$/i.test(s)) {
    const neg = s.startsWith("-");
    const m = /0x([0-9a-f]+)(?:\.([0-9a-f]*))?(?:p([+-]?\d+))?/i.exec(s)!;
    let v = parseInt(m[1], 16);
    if (m[2]) for (let i = 0; i < m[2].length; i++) v += parseInt(m[2][i], 16) / 16 ** (i + 1);
    v *= 2 ** Number(m[3] ?? 0);
    return neg ? -v : v;
  }
  return null;
}

function numericParams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of parseParameterStrings(s)) {
    const d = swiftDouble(v);
    if (d !== null) out.set(k, d);
  }
  return out;
}

/** Lanczos approximation of C's tgamma, good to ~15 digits for the arguments Weibull uses. */
export function tgamma(x: number): number {
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * tgamma(1 - x));
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  const z = x - 1;
  let a = c[0];
  const t = z + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (z + i);
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * a;
}

/** `QueueDistribution.computeMean`; null when not computable (or an unknown family). */
export function meanFromParameterString(distribution: string, params: string): number | null {
  const p = numericParams(params);
  const g = (k: string) => p.get(k);
  switch (distribution) {
    case "exponential": {
      const rate = g("rate");
      return rate !== undefined && rate > 0 ? 1 / rate : null;
    }
    case "gamma": {
      const shape = g("shape");
      const scale = g("scale");
      return shape !== undefined && scale !== undefined && shape > 0 && scale > 0 ? shape * scale : null;
    }
    case "uniform": {
      const a = g("min");
      const b = g("max");
      return a !== undefined && b !== undefined ? (a + b) / 2 : null;
    }
    case "constant": {
      const v = g("value");
      return v !== undefined ? v : null;
    }
    case "weibull": {
      const k = g("shape");
      const lam = g("scale");
      return k !== undefined && lam !== undefined && k > 0 && lam > 0 ? lam * tgamma(1 + 1 / k) : null;
    }
    case "erlang": {
      const k = g("k");
      const rate = g("rate");
      return k !== undefined && rate !== undefined && k > 0 && rate > 0 ? k / rate : null;
    }
    case "lognormal": {
      const mu = g("mu");
      const sigma = g("sigma");
      return mu !== undefined && sigma !== undefined ? Math.exp(mu + (sigma * sigma) / 2) : null;
    }
    case "pareto": {
      const alpha = g("shape");
      const xm = g("scale");
      return alpha !== undefined && xm !== undefined && alpha > 1 && xm > 0 ? (alpha * xm) / (alpha - 1) : null;
    }
    case "poisson": {
      const lambda = g("lambda");
      return lambda !== undefined && lambda > 0 ? 1 / lambda : null;
    }
    default:
      return null;
  }
}

/** `QueueDistribution.computeSCV`; null when not computable (or an unknown family). */
export function scvFromParameterString(distribution: string, params: string): number | null {
  const p = numericParams(params);
  const g = (k: string) => p.get(k);
  switch (distribution) {
    case "exponential":
      return 1;
    case "gamma": {
      const shape = g("shape");
      return shape !== undefined && shape > 0 ? 1 / shape : null;
    }
    case "uniform": {
      const a = g("min");
      const b = g("max");
      if (a === undefined || b === undefined || a + b === 0) return null;
      const diff = b - a;
      const sum = a + b;
      return (diff * diff) / (3 * sum * sum);
    }
    case "constant":
      return 0;
    case "weibull": {
      const k = g("shape");
      if (k === undefined || !(k > 0)) return null;
      const g1 = tgamma(1 + 1 / k);
      const g2 = tgamma(1 + 2 / k);
      if (!(g1 > 0)) return null;
      return (g2 - g1 * g1) / (g1 * g1);
    }
    case "erlang": {
      const k = g("k");
      return k !== undefined && k > 0 ? 1 / k : null;
    }
    case "lognormal": {
      const sigma = g("sigma");
      return sigma !== undefined ? Math.exp(sigma * sigma) - 1 : null;
    }
    case "pareto": {
      const alpha = g("shape");
      return alpha !== undefined && alpha > 2 ? 1 / (alpha * (alpha - 2)) : null;
    }
    case "poisson": {
      const lambda = g("lambda");
      return lambda !== undefined && lambda > 0 ? 1 : null;
    }
    default:
      return null;
  }
}

/** The detail row: "b=N" (finite only), a station's law (+ " c=N") or "Multi-class", a source's law; a sink none. */
export function detailText(node: BnetNode, infiniteBuffers: boolean): string | null {
  switch (node.kind) {
    case "buffer":
      return infiniteBuffers ? null : w.bufferDetail(node.bufferSize);
    case "station": {
      const servers = node.numberOfServers > 1 ? w.servers(node.numberOfServers) : "";
      if (Object.keys(node.serviceDistributions ?? {}).length > 1) return w.multiClass + servers;
      return distributionDisplayName(node.distribution) + servers;
    }
    case "source":
      return distributionDisplayName(node.distribution);
    case "sink":
      return null;
  }
}

/** "μ=2.5 · SCV=1" (station) or "λ=… · SCV=…" (source); parts that can't be computed are left out. */
export function rateText(node: BnetNode): string | null {
  const label = node.kind === "station" ? "μ" : node.kind === "source" ? "λ" : null;
  if (!label) return null;
  const parts: string[] = [];
  const mean = meanFromParameterString(node.distribution, node.distributionParameters);
  if (mean !== null && mean > 0) parts.push(`${label}=${formatSig(1 / mean, 4)}`);
  const scv = scvFromParameterString(node.distribution, node.distributionParameters);
  if (scv !== null) parts.push(`SCV=${formatSig(scv, 3)}`);
  return parts.length ? parts.join(" · ") : null;
}

/** The rate row said in words, for VoiceOver and the tooltip. */
export function rateDescription(node: BnetNode): string | null {
  const isSource = node.kind === "source";
  if (!isSource && node.kind !== "station") return null;
  const parts: string[] = [];
  const mean = meanFromParameterString(node.distribution, node.distributionParameters);
  if (mean !== null && mean > 0) {
    const rate = formatSig(1 / mean, 4);
    parts.push(isSource ? w.arrivalRate(rate) : w.serviceRate(rate));
  }
  const scv = scvFromParameterString(node.distribution, node.distributionParameters);
  if (scv !== null) {
    const k = scv === 1 ? w.scvKind.exponential : scv === 0 ? w.scvKind.deterministic : scv > 1 ? w.scvKind.bursty : w.scvKind.steady;
    parts.push(w.scvSpoken(formatSig(scv, 3), k));
  }
  return parts.length ? parts.join(", ") : null;
}

/** "<Kind> <name>, <detail>, <rate description>, utilisation ρ <2 sig.>" (CAN-200). */
export function nodeDescription(node: BnetNode, infiniteBuffers: boolean, rho: number | undefined): string {
  const parts = [`${KIND_NAMES[node.kind]} ${node.name}`];
  const d = detailText(node, infiniteBuffers);
  if (d) parts.push(d);
  const r = rateDescription(node);
  if (r) parts.push(r);
  // Priority service, batch arrivals, a rate profile (new in 2.1): what the node's mark says.
  for (const f of nodeFeatures(node)) parts.push(f.label);
  if (rho !== undefined) parts.push(w.utilisationSpoken(formatSig(rho, 2)));
  return parts.join(", ");
}

/** The tooltip: the description plus the glossary line for each symbol drawn (CAN-158). */
export function nodeTooltip(node: BnetNode, infiniteBuffers: boolean, rho: number | undefined): string {
  const lines = [nodeDescription(node, infiniteBuffers, rho)];
  if (node.kind === "source") lines.push(w.glossary.lambda);
  else if (node.kind === "station") lines.push(w.glossary.mu);
  if (rateText(node)?.includes("SCV")) lines.push(w.glossary.scv);
  return lines.join("\n");
}

export type RhoLevel = "light" | "moderate" | "heavy";

/** Danger ≥ 0.9, warning ≥ 0.7, success below (ANA-189). */
export function rhoLevel(rho: number): RhoLevel {
  return rho >= 0.9 ? "heavy" : rho >= 0.7 ? "moderate" : "light";
}

/** "ρ 0.87". */
export function rhoBadgeText(rho: number): string {
  return w.rhoBadge(formatSig(rho, 2));
}

/** The badge's tooltip (ANA-190). */
export function rhoTooltip(rho: number): string {
  const load = rho >= 1 ? w.rhoLoad.unstable : rho >= 0.9 ? w.rhoLoad.heavy : rho >= 0.7 ? w.rhoLoad.moderate : w.rhoLoad.light;
  return w.rhoHelp(formatSig(rho, 3), load);
}
