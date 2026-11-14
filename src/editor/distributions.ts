// The distribution families a node's law can take (0.90.34 `QueueDistribution`): the raw value is
// what a .bnet stores in `distribution`. The inspector's editing arithmetic is the inspector's;
// this is only what the editor model itself needs (names and defaults).

export const DISTRIBUTIONS = ["exponential", "gamma", "uniform", "constant", "weibull", "erlang", "lognormal", "pareto", "poisson"] as const;
export type Distribution = (typeof DISTRIBUTIONS)[number];

const DISPLAY: Record<Distribution, string> = {
  exponential: "Exponential",
  gamma: "Gamma",
  uniform: "Uniform",
  constant: "Deterministic",
  weibull: "Weibull",
  erlang: "Erlang",
  lognormal: "Lognormal",
  pareto: "Pareto",
  poisson: "Poisson",
};

const DEFAULTS: Record<Distribution, string> = {
  exponential: "rate=1.0",
  gamma: "shape=2.0,scale=1.0",
  uniform: "min=0.5,max=1.5",
  constant: "value=1.0",
  weibull: "shape=1.5,scale=1.0",
  erlang: "k=2,rate=1.0",
  lognormal: "mu=0.0,sigma=0.25",
  pareto: "shape=2.5,scale=1.0",
  poisson: "lambda=1.0",
};

export function isDistribution(s: string): s is Distribution {
  return (DISTRIBUTIONS as readonly string[]).includes(s);
}

/** `QueueDistribution.displayName`; an unknown raw value shows as itself. */
export function distributionDisplayName(d: string): string {
  return isDistribution(d) ? DISPLAY[d] : d;
}

/** `QueueDistribution.defaultParameters`. */
export function defaultParameters(d: string): string {
  return isDistribution(d) ? DEFAULTS[d] : "";
}
