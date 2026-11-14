// The distribution families and the editing arithmetic, with numbers pinned (ledger DIST-001…043,
// INS-140…146). Each expected value is what 0.90.34's Swift computes and prints: `%.10g` for field
// text (`fieldText`), `%.6g` for the shortened display, DS.Number.format at five significant digits
// (`formatSig`) for readouts and summaries.
import { describe, expect, it } from "vitest";
import {
  card,
  changeDistribution,
  commitMomentsToNative,
  compactSummary,
  computeMean,
  computeSCV,
  defaultDraft,
  derivedFromMoments,
  displayMeanText,
  displayParam,
  displayText,
  draftErrors,
  draftsEqual,
  familiesFor,
  fieldText,
  cG,
  isPartialNumber,
  lawDescription,
  makeDraft,
  moments,
  parameterDefs,
  parameterString,
  parametersFromMoments,
  parseInteger,
  parseNumber,
  parseParameterStrings,
  pendingFieldNames,
  scvError,
  setMeanText,
  setParam,
  setScvText,
  settledErrors,
  shortLabel,
  syncMode,
  tgamma,
  validateParameters,
  DISTRIBUTIONS,
} from ".";

describe("numbers (DS.Number)", () => {
  it("writes field text as C's %.10g", () => {
    expect(fieldText(1)).toBe("1");
    expect(fieldText(1.1111111)).toBe("1.1111111");
    expect(fieldText(1 / 3)).toBe("0.3333333333");
    expect(fieldText(1e-9)).toBe("1e-09");
    expect(fieldText(1e9)).toBe("1000000000");
    expect(fieldText(123456789012)).toBe("1.23456789e+11");
    expect(fieldText(0.0001)).toBe("0.0001");
    expect(fieldText(0.00001234)).toBe("1.234e-05");
    expect(fieldText(Infinity)).toBe("");
    expect(fieldText(NaN)).toBe("");
    expect(cG(2 / 3, 6)).toBe("0.666667");
    expect(cG(100000, 6)).toBe("100000");
    expect(cG(1000000, 6)).toBe("1e+06");
    expect(cG(-0.5, 6)).toBe("-0.5");
  });

  it("parses canonical, decimal-comma, grouped and scientific text, refusing non-finite values", () => {
    expect(parseNumber("1e-3")).toBe(0.001);
    expect(parseNumber("0,5")).toBe(0.5);
    expect(parseNumber("1,25")).toBe(1.25);
    expect(parseNumber("1,000")).toBe(1000);
    expect(parseNumber("1,000.5")).toBe(1000.5);
    expect(parseNumber("1,5e-3")).toBe(0.0015);
    expect(parseNumber(" 2 ")).toBe(2);
    expect(parseNumber(".5")).toBe(0.5);
    expect(parseNumber("abc")).toBeNull();
    expect(parseNumber("inf")).toBeNull();
    expect(parseNumber("")).toBeNull();
    expect(parseInteger("1,000")).toBe(1000);
    expect(parseInteger(" 12 ")).toBe(12);
    expect(parseInteger("2.5")).toBeNull();
    expect(parseInteger("abc")).toBeNull();
  });

  it("knows a number still being typed", () => {
    for (const t of ["", "-", "+", ".", ",", "-.", "-,", "1e", "1e-", "1E+", "0,5e"]) expect(isPartialNumber(t), t).toBe(true);
    for (const t of ["e", "1.2.3", "abc", "1x"]) expect(isPartialNumber(t), t).toBe(false);
  });
});

describe("the nine families (DIST-001…032)", () => {
  it("offers nine families to a source and eight to a station, in picker order", () => {
    expect(DISTRIBUTIONS).toEqual(["exponential", "gamma", "uniform", "constant", "weibull", "erlang", "lognormal", "pareto", "poisson"]);
    expect(familiesFor("source")).toHaveLength(9);
    expect(familiesFor("station")).not.toContain("poisson");
    expect(card("poisson").pickerName).toBe("Poisson process (Exp. inter-arrivals)");
    expect(card("constant").displayName).toBe("Deterministic");
    expect(card("gamma").menuSubtitle).toBe("c² = 1/k");
  });

  it("computes the mean and SCV of each family", () => {
    expect(computeMean("exponential", { rate: 4 })).toBe(0.25);
    expect(computeMean("poisson", { lambda: 4 })).toBe(0.25);
    expect(computeSCV("poisson", { lambda: 4 })).toBe(1);
    expect(computeMean("gamma", { shape: 2, scale: 3 })).toBe(6);
    expect(computeSCV("uniform", { min: 0.5, max: 1.5 })).toBe(1 / 12);
    expect(computeSCV("uniform", { min: -1, max: 1 })).toBeNull();
    expect(computeMean("erlang", { k: 2, rate: 1 })).toBe(2);
    expect(computeSCV("pareto", { shape: 2 })).toBeNull();
    expect(computeMean("pareto", { shape: 1.5, scale: 1 })).toBe(3);
    expect(computeMean("exponential", {})).toBeNull();
    expect(computeMean("weibull", { shape: 1.5, scale: 1 })).toBeCloseTo(0.9027452929509336, 13);
    expect(computeSCV("weibull", { shape: 1.5, scale: 1 })).toBeCloseTo(0.4609984862063179, 13);
    expect(computeMean("lognormal", { mu: 0, sigma: 0.25 })).toBeCloseTo(Math.exp(0.03125), 15);
  });

  it("solves (mean, SCV) into native parameters, refusing infeasible pairs", () => {
    expect(parametersFromMoments("gamma", 2, 0.25)).toEqual({ shape: 4, scale: 0.5 });
    expect(parametersFromMoments("erlang", 2, 0.3)).toEqual({ k: 3, rate: 1.5 });
    expect(parametersFromMoments("uniform", 1, 1)).toBeNull();
    expect(parametersFromMoments("gamma", 1, 0)).toBeNull();
    expect(parametersFromMoments("exponential", 0, 1)).toBeNull();
    const w = parametersFromMoments("weibull", 1, 1)!;
    expect(w.shape).toBeCloseTo(1, 9);
    expect(w.scale).toBeCloseTo(1, 9);
    const p = parametersFromMoments("pareto", 2, 0.5)!;
    expect(fieldText(p.shape)).toBe("2.732050808");
    expect(fieldText(p.scale)).toBe("1.267949192");
    const ln = parametersFromMoments("lognormal", 1, 1)!;
    expect(fieldText(ln.mu)).toBe("-0.3465735903");
    expect(fieldText(ln.sigma)).toBe("0.8325546112");
  });

  it("validates each parameter and the cross-field rules", () => {
    expect(validateParameters("gamma", { shape: 0, scale: 1 }).shape).toBe("Shape (k) must be > 0.");
    expect(validateParameters("erlang", { k: 2.5, rate: 1 }).k).toBe("Stages (k) must be a whole number.");
    expect(validateParameters("uniform", { min: 2, max: 1 }).max).toBe("Max must be greater than Min.");
    expect(Object.keys(validateParameters("uniform", { min: -1, max: -2 })).sort()).toEqual(["max", "min"]);
    expect(validateParameters("uniform", { min: -1, max: 2 }).min).toBe("Min (a) must be ≥ 0.");
    expect(validateParameters("exponential", { rate: NaN }).rate).toBe("Rate (λ) must be a finite number.");
    // DIST-025, Changed: the Shape field states the rule Save enforces.
    expect(validateParameters("pareto", { shape: 1.5, scale: 1 }).shape).toBe("Shape (α) must be > 2.");
    expect(validateParameters("pareto", { shape: 2.5, scale: 1 })).toEqual({});
  });

  it("reads parameter strings as 0.90.34 split them", () => {
    const m = parseParameterStrings("rate=1,rate=7, k = 3 ,x=1=2,shape=1e-3");
    expect(m.rate).toBe("7");
    expect(m.k).toBe("3");
    expect(m.x).toBeUndefined();
    expect(m.shape).toBe("1e-3");
    expect(parseParameterStrings("k==3").k).toBe("3");
  });

  it("computes Γ as C's tgamma does", () => {
    expect(tgamma(0.5)).toBeCloseTo(Math.sqrt(Math.PI), 14);
    expect(tgamma(5)).toBe(24);
    expect(tgamma(5.5) / 52.34277778455352).toBeCloseTo(1, 13);
    expect(tgamma(170.5) / 5.56209241456e305).toBeCloseTo(1, 9);
    expect(tgamma(0)).toBeNaN();
  });
});

describe("the distribution draft (DIST-033…043)", () => {
  it("builds from a stored string: defined keys as %.10g, others defaulted, foreign keys dropped", () => {
    const d = makeDraft("gamma", "shape=2.50,bogus=3");
    expect(d.params).toEqual({ shape: "2.5", scale: "1" });
    expect(d.meanText).toBe("2.5");
    expect(d.scvText).toBe("0.4");
    expect(parameterString(d)).toBe("shape=2.5,scale=1");
    expect(parameterString(defaultDraft("exponential"))).toBe("rate=1");
  });

  it("keeps the mean when the family changes, with the new family's SCV", () => {
    const expo = makeDraft("exponential", "rate=0.5");
    const gamma = changeDistribution(expo, "gamma", "native");
    expect(gamma.params).toEqual({ shape: "1", scale: "2" });
    // Deterministic → Gamma: SCV max(0, 1e-9) gives shape 1e9.
    const det = changeDistribution(makeDraft("constant", "value=1"), "gamma", "native");
    expect(det.params).toEqual({ shape: "1000000000", scale: "1e-09" });
    // Exponential → Uniform: SCV 1 is infeasible, so the family defaults.
    expect(changeDistribution(defaultDraft("exponential"), "uniform", "native").params).toEqual({ min: "0.5", max: "1.5" });
    expect(changeDistribution(expo, "exponential", "native")).toBe(expo);
  });

  it("names its problems in 0.90.34's words", () => {
    let d = setParam(defaultDraft("exponential"), "rate", "abc");
    expect(draftErrors(d, "native")).toEqual({ rate: "Enter a number for Rate (λ)." });
    d = setMeanText(defaultDraft("gamma"), "");
    expect(draftErrors(d, "moments").mean).toBe("Enter a positive mean.");
    expect(draftErrors(setMeanText(d, "-1"), "moments").mean).toBe("Mean must be > 0.");
    const g = setMeanText(defaultDraft("gamma"), "2");
    expect(scvError(setScvText(g, "x"))).toBe("Enter an SCV (c²) ≥ 0.");
    expect(scvError(setScvText(g, "-1"))).toBe("SCV must be ≥ 0.");
    expect(scvError(setScvText(g, "0"))).toBe("SCV 0 is Deterministic — pick that family.");
    expect(scvError(setScvText(setMeanText(defaultDraft("uniform"), "1"), "1"))).toBe("Mean and SCV infeasible for Uniform.");
    expect(scvError(defaultDraft("exponential"))).toBeNull();
  });

  it("reports half-typed numbers as pending, not as settled errors", () => {
    const d = setParam(defaultDraft("gamma"), "scale", "1e-");
    expect(pendingFieldNames(d, "native")).toEqual(["Scale (θ)"]);
    expect(settledErrors(d, "native")).toEqual([]);
    expect(draftErrors(d, "native").scale).toBe("Enter a number for Scale (θ).");
    expect(pendingFieldNames(setMeanText(d, ""), "moments")).toEqual(["Mean"]);
  });

  it("switches entry mode without losing input", () => {
    const g = makeDraft("gamma", "shape=4,scale=0.5");
    const m = syncMode(g, "moments");
    expect([m.meanText, m.scvText]).toEqual(["2", "0.25"]);
    const typed = setScvText(setMeanText(m, "3"), "0.5");
    expect(syncMode(typed, "native").params).toEqual({ shape: "2", scale: "1.5" });
    // No solution: the native text stays as it was.
    expect(syncMode(setMeanText(m, "-1"), "native").params).toEqual(g.params);
  });

  it("shows realised moments and notes Erlang's snap at commit", () => {
    const e = setScvText(setMeanText(syncMode(defaultDraft("erlang"), "moments"), "2"), "0.3");
    expect(derivedFromMoments(e)).toMatchObject({ params: { k: 3, rate: 1.5 }, mean: 2 });
    expect(moments(e, "moments").scv).toBeCloseTo(1 / 3, 15);
    const { draft, note } = commitMomentsToNative(e, "Class 2: ");
    expect(draft.params).toEqual({ k: "3", rate: "1.5" });
    expect(note).toBe("Class 2: Erlang snapped SCV to 0.33333 (you entered 0.3).");
    expect(commitMomentsToNative(setScvText(e, "0.25"), "").note).toBeNull();
  });

  it("shows generated values at %.6g and typed ones verbatim", () => {
    expect(displayText("0.3333333333")).toBe("0.333333");
    expect(displayText("12345678")).toBe("12345678");
    expect(displayText("1e-")).toBe("1e-");
    const ln = changeDistribution(defaultDraft("exponential"), "lognormal", "native");
    expect(ln.params.sigma).toBe("0.8325546112");
    expect(displayParam(ln, "sigma")).toBe("0.832555");
    expect(displayParam(setParam(ln, "sigma", "0.8325546112"), "sigma")).toBe("0.8325546112");
    expect(displayMeanText(makeDraft("exponential", "rate=3"))).toBe("0.333333");
  });

  it("writes the canonical string and compares laws numerically", () => {
    expect(parameterString(makeDraft("exponential", "rate=2.0"))).toBe(parameterString(makeDraft("exponential", "rate=2")));
    expect(parameterString(setParam(defaultDraft("exponential"), "rate", "abc"))).toBe("rate=abc");
    expect(parameterString(setParam(defaultDraft("exponential"), "rate", "0,5"))).toBe("rate=0.5");
  });

  it("summarises compactly with short labels", () => {
    expect(compactSummary(makeDraft("gamma", "shape=2,scale=0.5"))).toBe("k=2, θ=0.5");
    expect(compactSummary(makeDraft("lognormal", "mu=0,sigma=0.25"))).toBe("μ=0, σ=0.25");
    expect(compactSummary(setParam(defaultDraft("exponential"), "rate", "x"))).toBe("λ=?");
    expect(compactSummary(makeDraft("exponential", "rate=1.1111111"))).toBe("λ=1.1111");
    expect(shortLabel("Stages (k)")).toBe("k");
    expect(shortLabel("Scale (xₘ)")).toBe("xₘ");
    expect(lawDescription("gamma", "shape=2,scale=0.5")).toBe("Gamma(k=2, θ=0.5)");
    for (const d of DISTRIBUTIONS) expect(parameterDefs(d).length).toBeGreaterThan(0);
  });

  it("compares drafts by value", () => {
    expect(draftsEqual(defaultDraft("gamma"), defaultDraft("gamma"))).toBe(true);
    expect(draftsEqual(defaultDraft("gamma"), setParam(defaultDraft("gamma"), "shape", "2"))).toBe(false);
  });
});
