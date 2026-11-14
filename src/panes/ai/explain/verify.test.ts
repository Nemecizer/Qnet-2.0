// The answer check (./verify.ts; ledger WF-403): the rule stated at the top of that file, case by
// case — percentages and fractions, rounding, units, intervals, the numbers that are not results,
// and the three ways a citation can be wrong.
import { describe, expect, it } from "vitest";
import type { Fact, NumberFact } from "./facts";
import { forgetFacts, factsOf, Sheet } from "./facts";
import { numbersIn, parameterInputs, verifyAnswer, withFlags, withoutFlags, type VerifyContext } from "./verify";

const fact = (handle: string, value: number, unit: string, extra: Partial<NumberFact> = {}): NumberFact => ({ kind: "number", handle, what: handle, value, unit, tier: "exact", source: "test", target: { kind: "none" }, networkKey: "net-1", ...extra });
const FACTS: Fact[] = [
  fact("live:S2:rho", 0.8, "ratio"),
  fact("live:S1:rho", 0.4861111, "ratio"),
  fact("live:S2:number", 4, "customers"),
  fact("live:network:delay", 5.3333333, "time"),
  fact("run:1a2b3c4d:S2:number", 4.12, "customers", { low: 3.9, high: 4.34, tier: "simulation" }),
  fact("sens:delay:mu_S2", -3.25, ""),
  fact("agree:S2:number:QNA:dev", -0.0321, "ratio"),
  fact("cap:S2:servers", 3, "servers"),
  fact("net:lambda_Src1", 1234.5, "per time unit"),
  fact("trans:S2:tiny", 0.00012345, "customers"),
  { kind: "text", handle: "help:qna", what: "Help", text: "QNA (Whitt 1983) is usually within 10 % for moderate loads. It needs ρ < 1.", source: "Qnet Help: QNA", target: { kind: "help", topic: "qna" }, networkKey: null },
  { kind: "text", handle: "app:version", what: "Software", text: "Qnet 2.1.0", source: "This copy of Qnet", target: { kind: "none" }, networkKey: null },
];
const ctx = (over: Partial<VerifyContext> = {}): VerifyContext => ({ facts: new Map(FACTS.map((f) => [f.handle, f])), networkKey: "net-1", inputs: [], ...over });
const check = (text: string, over: Partial<VerifyContext> = {}) => verifyAnswer(text, ctx(over));
const statuses = (text: string, over: Partial<VerifyContext> = {}) => check(text, over).numbers.map((n) => `${n.text}:${n.status}`);

describe("a cited number", () => {
  it("is verified when it equals the fact, as a fraction or as a percentage", () => {
    expect(statuses("ρ at S2 is 0.8 [live:S2:rho].")).toEqual(["0.8:verified"]);
    expect(statuses("S2 is busy 80 % [live:S2:rho] of the time.")).toEqual(["80:verified"]);
    expect(statuses("S2 is busy 80% [live:S2:rho] of the time.")).toEqual(["80:verified"]);
    expect(statuses("S2 is busy 80 percent [live:S2:rho] of the time.")).toEqual(["80:verified"]);
  });

  it("may be rounded: it must equal the fact rounded to the decimals written, and be within 10 % of it", () => {
    expect(statuses("0.49 [live:S1:rho]")).toEqual(["0.49:verified"]);
    expect(statuses("48.6 % [live:S1:rho]")).toEqual(["48.6:verified"]);
    expect(statuses("49 % [live:S1:rho]")).toEqual(["49:verified"]);
    expect(statuses("0.5 [live:S1:rho]")).toEqual(["0.5:verified"]);
    expect(statuses("5.33 time units [live:network:delay]")).toEqual(["5.33:verified"]);
    expect(statuses("about 5 time units [live:network:delay]")).toEqual(["5:verified"]);
    // Wrong in the last place written.
    expect(statuses("0.48 [live:S1:rho]")).toEqual(["0.48:mismatch"]);
    expect(statuses("5.34 [live:network:delay]")).toEqual(["5.34:mismatch"]);
    // "1" is 0.8 rounded to no decimals, but a quarter off: not a rounding.
    expect(statuses("about 1 customer in total [live:S2:rho]")).toEqual(["1:mismatch"]);
    expect(statuses("0 [live:S1:rho]")).toEqual(["0:mismatch"]);
  });

  it("is a wrong unit when the percent sign or the unit word is not the fact's", () => {
    // A ratio written without % but a hundred times too large, and with % but as the fraction.
    expect(statuses("ρ is 80 [live:S2:rho]")).toEqual(["80:mismatch"]);
    expect(statuses("ρ is 0.8 % [live:S2:rho]")).toEqual(["0.8:mismatch"]);
    // The right digits under the wrong unit.
    expect(statuses("0.8 customers [live:S2:rho]")).toEqual(["0.8:unit"]);
    expect(statuses("4 time units [live:S2:number]")).toEqual(["4:unit"]);
    expect(statuses("4 % [live:S2:number]")).toEqual(["4:unit"]);
    expect(statuses("4 customers [live:S2:number]")).toEqual(["4:verified"]);
    expect(check("0.8 customers [live:S2:rho]").flagged[0]).toMatchObject({ status: "unit", handle: "live:S2:rho", cited: "0.8 (ratio)" });
  });

  it("may be an end of the fact's interval", () => {
    expect(statuses("4.12 customers, 95 % interval 3.9 to 4.34 [run:1a2b3c4d:S2:number]")).toEqual(["4.12:verified", "3.9:verified", "4.34:verified"]);
    expect(statuses("between 3.9 and 4.5 [run:1a2b3c4d:S2:number]")).toEqual(["3.9:verified", "4.5:mismatch"]);
    expect(statuses("3.9–4.34 [run:1a2b3c4d:S2:number]")).toEqual(["3.9:verified", "4.34:verified"]);
  });

  it("keeps its sign when it writes one, and may give a negative fact's size in words", () => {
    expect(statuses("an elasticity of −3.25 [sens:delay:mu_S2]")).toEqual(["−3.25:verified"]);
    expect(statuses("an elasticity of -3.25 [sens:delay:mu_S2]")).toEqual(["-3.25:verified"]);
    expect(statuses("QNA is 3.2 % below the reference [agree:S2:number:QNA:dev]")).toEqual(["3.2:verified"]);
    expect(statuses("QNA is −3.2 % off [agree:S2:number:QNA:dev]")).toEqual(["−3.2:verified"]);
    expect(statuses("ρ is −0.8 [live:S2:rho]")).toEqual(["−0.8:mismatch"]);
    // An elasticity has no unit: "%" is allowed and does not rescale it.
    expect(statuses("a 3.25 % drop [sens:delay:mu_S2]")).toEqual(["3.25:verified"]);
  });

  it("reads thousands separators and exponents", () => {
    expect(statuses("1,234.5 per time unit [net:lambda_Src1]")).toEqual(["1,234.5:verified"]);
    expect(statuses("1.2345e-4 [trans:S2:tiny]")).toEqual(["1.2345e-4:verified"]);
    expect(statuses("1.3e-4 [trans:S2:tiny]")).toEqual(["1.3e-4:mismatch"]);
  });

  it("each handle vouches for the numbers before it, back to the previous handle; several handles in a row share them", () => {
    expect(statuses("ρ is 0.8 [live:S2:rho] at S2 and 0.49 [live:S1:rho] at S1.")).toEqual(["0.8:verified", "0.49:verified"]);
    expect(statuses("ρ is 0.8 at S2 and 0.49 at S1 [live:S2:rho] [live:S1:rho].")).toEqual(["0.8:verified", "0.49:verified"]);
    expect(statuses("ρ is 0.49 [live:S2:rho] at S2 and 0.8 [live:S1:rho] at S1.")).toEqual(["0.49:mismatch", "0.8:mismatch"]);
    // A handle before the number, or in the next sentence, vouches for nothing.
    expect(statuses("At S2 [live:S2:rho] the utilisation is 0.8.")).toEqual(["0.8:unverified"]);
    expect(statuses("The utilisation is 0.8. See [live:S2:rho].")).toEqual(["0.8:unverified"]);
    expect(statuses("| S2 | 0.8 | [live:S2:rho] |")).toEqual(["0.8:unverified"]);
    expect(statuses("| S2 | 0.8 [live:S2:rho] | 4 [live:S2:number] |")).toEqual(["0.8:verified", "4:verified"]);
  });
});

describe("what is flagged", () => {
  it("a fabricated number: no handle after it", () => {
    const c = check("The mean wait at S2 is 12.7 time units. Utilisation is 0.8 [live:S2:rho].");
    expect(c.numbers.map((n) => n.status)).toEqual(["unverified", "verified"]);
    expect(c.flagged.map((f) => f.text)).toEqual(["12.7"]);
    // Slipped in before someone else's handle in the same clause, it is held against that handle and fails.
    expect(statuses("The mean wait at S2 is 12.7 time units, and utilisation is 0.8 [live:S2:rho].")).toEqual(["12.7:mismatch", "0.8:verified"]);
    expect(statuses("```\nrho = 0.93\n```")).toEqual(["0.93:unverified"]);
    expect(statuses("so `0.93` it is")).toEqual(["0.93:unverified"]);
  });

  it("a number that cites a fact with another value", () => {
    expect(check("ρ at S2 is 0.9 [live:S2:rho].").flagged[0]).toMatchObject({ text: "0.9", status: "mismatch", handle: "live:S2:rho", cited: "0.8 (ratio)" });
  });

  it("a stale citation: the network changed after the fact was read", () => {
    const c = check("ρ at S2 is 0.8 [live:S2:rho].", { networkKey: "net-2" });
    expect(c.flagged[0]).toMatchObject({ text: "0.8", status: "stale" });
    expect(c.handles[0]).toMatchObject({ handle: "live:S2:rho", status: "stale" });
    // A Help passage belongs to no network.
    expect(statuses("within 10 % [help:qna]", { networkKey: "net-2" })).toEqual(["10:help"]);
  });

  it("an unknown citation: a handle the assistant was never given", () => {
    const c = check("ρ at S9 is 0.8 [live:S9:rho].");
    expect(c.flagged[0]).toMatchObject({ text: "0.8", status: "unknown", handle: "live:S9:rho" });
    expect(c.handles[0].status).toBe("unknown");
    // Square brackets that are not a handle are just text.
    expect(check("see [1] and [note: 3 things]").handles).toEqual([]);
  });

  it("a number quoted from Help or the version must stand in that text", () => {
    expect(statuses("QNA is usually within 10 % [help:qna].")).toEqual(["10:help"]);
    expect(statuses("QNA is usually within 5 % [help:qna].")).toEqual(["5:mismatch"]);
    expect(statuses("Analysed with Qnet 2.1.0 [app:version].")).toEqual(["2.1.0:verified"]);
    expect(statuses("Analysed with Qnet 2.1 [app:version].")).toEqual(["2.1:verified"]);
    expect(statuses("Analysed with Qnet 3.0 [app:version].")).toEqual(["3.0:mismatch"]);
    expect(statuses("Analysed with Qnet 2.1.0.")).toEqual(["2.1.0:unverified"]);
  });
});

// Ledger WF-505.
describe("a number cited to Help", () => {
  it("is from Help, never a verified result, and is not flagged", () => {
    const c = check("QNA is usually within 10 % [help:qna]; S2 is 80 % [live:S2:rho] busy.");
    expect(c.numbers.map((n) => `${n.text}:${n.status}`)).toEqual(["10:help", "80:verified"]);
    expect(c.flagged).toEqual([]);
  });

  it("cannot vouch for a result: a Help handle does not verify a number, and a result handle beside it still decides", () => {
    // 10 stands in the article; cited to Help alone it is from Help, not a verified utilisation.
    expect(statuses("S2 is 10 % [help:qna] busy.")).toEqual(["10:help"]);
    // With a result handle beside the Help handle: verified only when the result has the number.
    expect(statuses("S2 is 80 % [live:S2:rho] [help:qna] busy.")).toEqual(["80:verified"]);
    expect(statuses("S2 is 80 % [help:qna], [live:S2:rho] busy.")).toEqual(["80:verified"]);
    expect(statuses("S2 is 10 % [live:S2:rho] [help:qna] busy.")).toEqual(["10:help"]);
    expect(statuses("S2 is 55 % [live:S2:rho] [help:qna] busy.")).toEqual(["55:mismatch"]);
  });

  it("must stand in the passage the assistant was handed, not elsewhere in the article", () => {
    forgetFacts();
    const article = `QNA is usually within 10 % for moderate loads.${" filler".repeat(40)} In heavy traffic the error can reach 35 %.`;
    const first = article.slice(0, 60);
    new Sheet("tab-help").passage({ handle: "help:qna", what: "Help (part 1 of 2)", text: article, source: "Qnet Help: QNA", target: { kind: "help", topic: "qna" } }, first).text();
    const told = () => ({ facts: factsOf("tab-help"), networkKey: null });
    expect(statuses("Within 10 % [help:qna], at worst 35 % [help:qna].", told())).toEqual(["10:help", "35:mismatch"]);
    // The second part read: now both were handed over.
    new Sheet("tab-help").passage({ handle: "help:qna", what: "Help (part 2 of 2)", text: article, source: "Qnet Help: QNA", target: { kind: "help", topic: "qna" } }, article.slice(60)).text();
    expect(statuses("Within 10 % [help:qna], at worst 35 % [help:qna].", told())).toEqual(["10:help", "35:help"]);
    forgetFacts();
  });
});

describe("how numbers are written", () => {
  it("scientific notation", () => {
    expect(statuses("1.2345e-4 customers [trans:S2:tiny]")).toEqual(["1.2345e-4:verified"]);
    expect(statuses("1.23E-4 customers [trans:S2:tiny]")).toEqual(["1.23E-4:verified"]);
    expect(statuses("1.2345e-3 customers [trans:S2:tiny]")).toEqual(["1.2345e-3:mismatch"]);
    expect(statuses("about 1.2345e-4 customers")).toEqual(["1.2345e-4:unverified"]);
  });
  it("thousands separators", () => {
    expect(statuses("1,234.5 per time unit [net:lambda_Src1]")).toEqual(["1,234.5:verified"]);
    expect(statuses("1,235 [net:lambda_Src1]")).toEqual(["1,235:verified"]);
    expect(statuses("2,234.5 [net:lambda_Src1]")).toEqual(["2,234.5:mismatch"]);
    // A comma between two numbers is not a separator.
    expect(statuses("0.8, 4 [live:S2:rho] [live:S2:number]")).toEqual(["0.8:verified", "4:verified"]);
  });
  it("negative numbers", () => {
    expect(statuses("the derivative is -3.25 [sens:delay:mu_S2]")).toEqual(["-3.25:verified"]);
    expect(statuses("the derivative is −3.25 [sens:delay:mu_S2]")).toEqual(["−3.25:verified"]);
    expect(statuses("the derivative is -3.25")).toEqual(["-3.25:unverified"]);
    expect(statuses("ρ is -0.8 [live:S2:rho]")).toEqual(["-0.8:mismatch"]);
  });
  it("a range: both ends are numbers, and the dash is not a minus sign", () => {
    expect(statuses("between 3.9–4.34 customers [run:1a2b3c4d:S2:number]")).toEqual(["3.9:verified", "4.34:verified"]);
    expect(statuses("between 3.9-4.34 customers [run:1a2b3c4d:S2:number]")).toEqual(["3.9:verified", "4.34:verified"]);
    expect(statuses("utilisation of 0.5–0.9 is typical")).toEqual(["0.5:unverified", "0.9:unverified"]);
    expect(statuses("utilisation of 0.5–0.8 [live:S2:rho]")).toEqual(["0.5:mismatch", "0.8:verified"]);
  });
  it("a number embedded in a handle is the handle's, never a claim", () => {
    expect(statuses("S2 holds 4.12 customers [run:1a2b3c4d:S2:number].")).toEqual(["4.12:verified"]);
    expect(statuses("See [run:1a2b3c4d:S2:number] and [live:S2:rho].")).toEqual([]);
    expect(statuses("See [run:99999999:S7:number].")).toEqual([]);
    expect(check("See [run:99999999:S7:number].").handles.map((h) => h.status)).toEqual(["unknown"]);
  });
});

describe("numbers that are not results (rule 5)", () => {
  const none = (text: string) => expect(statuses(text), text).toEqual([]);
  it("a. digits inside a name", () => {
    none("S2 follows S1; Src1 feeds B1. Each is an M/M/1 queue, or M/M/2, or a G/G/1 one.");
    none("Class C1 and station Station_12.");
  });
  it("b. counting and numbering the model or the text, list markers and ordinals", () => {
    none("The network has 2 stations, 3 links and 1 customer class.");
    none("I compared 2 methods. See step 2, option 1 and Class 2. The 2nd station is S2.");
    none("1. First point\n2. Second point\n3) Third");
    none("There are 3 more reasons and 2 things to try.");
    // Servers, customers, runs and samples are results or parameters: they need a handle.
    expect(statuses("S2 needs 3 servers.")).toEqual(["3:unverified"]);
    expect(statuses("S2 needs 3 servers [cap:S2:servers].")).toEqual(["3:verified"]);
    expect(statuses("S2 needs 4 servers [cap:S2:servers].")).toEqual(["4:mismatch"]);
    expect(statuses("On average 4 customers wait, over 10000 samples.")).toEqual(["4:unverified", "10000:unverified"]);
  });
  it("c. a confidence level", () => {
    none("the 95 % confidence interval, a 95% interval, a 99 % credible interval");
    expect(statuses("in 95 % of cases")).toEqual(["95:unverified"]);
  });
  it("d. a year after a name", () => {
    none("QNA (Whitt 1983) and Jackson (1957); Harrison and Williams, 1987; (1963)");
    expect(statuses("the delay is 1983 time units")).toEqual(["1983:unverified"]);
  });
  it("e. the bounds 0, 1 and 100 % in a comparison or a formula", () => {
    none("stable while ρ < 1; it must stay below 1, and never above 100 %. The factor 1/(1 − ρ) grows; 1 − ρ is the idle share; the mean service time is 1/μ.");
    expect(statuses("ρ is 1 at S2")).toEqual(["1:unverified"]);
    expect(statuses("ρ < 0.9")).toEqual(["0.9:unverified"]);
  });
  it("f. a number the assistant itself passed to a tool this turn is an input: plain, neither flagged nor verified", () => {
    const c = check("I set the service rate to 1.5 and asked for a 10 % cut; the delay is then 7.2.", { inputs: [1.5, -0.1] });
    expect(c.numbers.map((n) => `${n.text}:${n.status}`)).toEqual(["1.5:input", "10:input", "7.2:unverified"]);
    expect(c.flagged.map((f) => f.text)).toEqual(["7.2"]);
    expect(numbersIn({ name: "S2", distribution_parameters: "rate=1.5", number_of_servers: 2, nested: [{ x: 0.25 }] })).toEqual([1.5, 2, 0.25]);
  });
  // Ledger WF-505: a name the assistant passed to a tool is not a number it chose.
  it("f. digits in a name passed to a tool are not inputs, so a made-up number is still marked", () => {
    expect(numbersIn({ station: "S2", node: "Server 12", topic: "M/M/1", note: "about 7.5", measure: "x=3" })).toEqual([]);
    expect(numbersIn({ parameters: "k=2, rate=1.5e1, shape = -0.5", distribution_parameters: "lambda=0.8" })).toEqual([2, 15, -0.5, 0.8]);
    expect(numbersIn({ values: [0.5, 0.7], target: { value: 3 } })).toEqual([0.5, 0.7, 3]);
    const inputs = numbersIn({ station: "S2", node: "Server 12" });
    expect(statuses("The queue at S2 holds 2 customers and waits 12 time units.", { inputs })).toEqual(["2:unverified", "12:unverified"]);
    // What the old reading did: 2 and 12 taken from the names, and both made-up numbers passed.
    expect(statuses("The queue at S2 holds 2 customers and waits 12 time units.", { inputs: [2, 12] })).toEqual(["2:input", "12:input"]);
  });
  it("f. the network's parameters, as get_parameters gave them, are inputs while the network is as it was", () => {
    const facts = new Map<string, Fact>([["net:mu_S2", fact("net:mu_S2", 1.5, "per time unit", { tier: "input" })], ["live:S2:rho", fact("live:S2:rho", 0.8, "ratio")]]);
    expect(parameterInputs(facts, "net-1")).toEqual([1.5]);
    expect(parameterInputs(facts, "net-2")).toEqual([]);
    expect(statuses("S2 serves at rate 1.5 and is busy 0.8 of the time.", { facts, inputs: parameterInputs(facts, "net-1") })).toEqual(["1.5:input", "0.8:unverified"]);
  });
  it("words are not numbers", () => {
    none("Two stations, each about eighty percent busy.");
  });
});

describe("marking", () => {
  it("wraps the flagged numbers, and only those, and the marks come off again", () => {
    const text = "ρ is 0.8 [live:S2:rho] and the wait is 12.7.";
    const c = check(text);
    const marked = withFlags(text, c);
    expect(marked).toBe("ρ is 0.8 [live:S2:rho] and the wait is 012.7.");
    expect(withoutFlags(marked)).toBe(text);
    expect(withFlags(text, null)).toBe(text);
  });
});
