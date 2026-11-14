// Checks the colour tokens in styles.css (NetMon's contrast test, for Qnet's two themes): WCAG
// contrast for every pair the interface relies on, in Light and Dark and with Increase contrast,
// the OKLCH neutral ramp, and that the media-query copies match the attribute blocks. Parses the
// CSS text itself, so a token edit that breaks legibility fails here.
import { describe, expect, it } from "vitest";
import css from "../styles.css?raw";

type Tokens = Record<string, string>;

function block(selector: string, from = 0): string {
  const start = css.indexOf(`${selector} {`, from);
  if (start < 0) throw new Error(`no block ${selector}`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unterminated ${selector}`);
}

function parse(body: string): Tokens {
  const out: Tokens = {};
  for (const m of body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const light = parse(block(":root"));
const darkBody = block(':root[data-theme="dark"]');
const dark: Tokens = { ...light, ...parse(darkBody) };
const mediaDark = block(':root:not([data-theme="light"])', css.indexOf("@media (prefers-color-scheme: dark)"));
const more = parse(block(':root[data-contrast="more"]'));
const mediaMore = parse(block(":root:not([data-contrast])", css.indexOf("@media (prefers-contrast: more)")));

type RGB = [number, number, number];

function hexToRgb(hex: string): RGB {
  const h = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
  const n = parseInt(h.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Resolves a token to sRGB: hex, var() chains and `color-mix(in srgb, A p%, B)`. */
function resolve(t: Tokens, value: string, depth = 0): RGB {
  if (depth > 12) throw new Error(`cycle at ${value}`);
  const v = value.trim();
  if (v.startsWith("#")) return hexToRgb(v);
  const varm = /^var\((--[\w-]+)(?:,\s*(.+))?\)$/.exec(v);
  if (varm) {
    const next = t[varm[1]] ?? varm[2];
    if (next === undefined) throw new Error(`undefined ${varm[1]}`);
    return resolve(t, next, depth + 1);
  }
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%,\s*(.+)\)$/.exec(v);
  if (mix) {
    const a = resolve(t, mix[1], depth + 1);
    const b = resolve(t, mix[3], depth + 1);
    const p = Number(mix[2]) / 100;
    return [0, 1, 2].map((i) => a[i] * p + b[i] * (1 - p)) as RGB;
  }
  throw new Error(`can't resolve ${value}`);
}

const lin = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: RGB) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

function ratio(t: Tokens, a: string, b: string): number {
  const la = luminance(resolve(t, `var(${a})`));
  const lb = luminance(resolve(t, `var(${b})`));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function oklch([r, g, b]: RGB): [number, number, number] {
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, Bb), ((Math.atan2(Bb, A) * 180) / Math.PI + 360) % 360];
}

/** [foreground, background, minimum]: everything the interface needs to stay legible. */
const PAIRS: [string, string, number][] = [
  ["--text", "--surface", 7],
  ["--text", "--chrome", 7],
  ["--sel-text", "--sel", 4.5],
  ["--text", "--sel-inactive", 7],
  ["--text-2", "--surface", 4.5],
  ["--text-2", "--chrome", 4.5],
  ["--text-2", "--hover", 4.5],
  ["--muted", "--surface", 4.5],
  ["--muted", "--surface-2", 4.5],
  ["--muted", "--chrome", 4.5],
  ["--accent-text", "--surface", 4.5],
  ["--accent-text", "--chrome", 4.5],
  ["--on-accent", "--accent-fill", 4.5],
  ["--on-accent", "--danger-fill", 4.5],
  ["--good-text", "--surface", 4.5],
  ["--warn-text", "--surface", 4.5],
  ["--crit-text", "--surface", 4.5],
  ["--good-text", "--good-bg", 4.5],
  ["--warn-text", "--warn-bg", 4.5],
  ["--crit-text", "--crit-bg", 4.5],
  ["--accent-text", "--info-bg", 4.5],
  ["--field-border", "--surface", 3],
  ["--focus-ring", "--surface", 3],
  ["--warning-border", "--surface", 3],
  ["--critical", "--surface", 3],
  ["--hairline", "--surface", 1.4],
  ["--zebra", "--surface", 1.12],
  ["--surface", "--desk", 1.3],
];

describe.each([
  ["light", light],
  ["dark", dark],
  ["light, increased contrast", { ...light, ...more }],
  ["dark, increased contrast", { ...dark, ...more }],
])("%s theme contrast", (_name, t) => {
  it.each(PAIRS)("%s on %s ≥ %s:1", (fg, bg, min) => {
    expect(ratio(t, fg, bg)).toBeGreaterThanOrEqual(min);
  });
});

describe("selection", () => {
  it.each([["light", light], ["dark", dark]] as const)("keeps body text at 7:1 on the selection (%s)", (_, t) => {
    expect(ratio(t, "--text", "--sel")).toBeGreaterThanOrEqual(7);
    expect(t["--sel-text"]).toBe("var(--text)");
  });
  // --muted is under 4.5:1 on every theme's --sel, so a selected row's secondary text takes --sel-muted.
  it.each([["light", light], ["dark", dark]] as const)("keeps secondary text at AA on the selection (%s)", (_, t) => {
    for (const bg of ["--sel", "--sel-inactive"]) {
      expect(ratio(t, "--sel-muted", bg), bg).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t, "--text-2", bg), bg).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("turns the selection solid under Increase contrast, with white text on it", () => {
    for (const t of [{ ...light, ...more }, { ...dark, ...more }]) expect(ratio(t, "--sel-text", "--sel")).toBeGreaterThanOrEqual(7);
  });
});

describe("neutral ramp", () => {
  it.each([["light", light], ["dark", dark]] as const)("is 12 OKLCH steps at hue 255, chroma 0.005–0.012 (%s)", (_name, t) => {
    const steps = Array.from({ length: 12 }, (_, i) => oklch(resolve(t, `var(--gray-${i + 1})`)));
    for (const [L, C, h] of steps) {
      // 0.005 at the near-white end rounds to ~0.0035 once stored as a hex value.
      expect(C).toBeGreaterThanOrEqual(0.003);
      expect(C).toBeLessThanOrEqual(0.0135);
      if (C > 0.004) expect(Math.abs(h - 255)).toBeLessThan(14);
      expect(L).toBeGreaterThan(0);
    }
    // Steps 2–12 run one way: from the pane surface to the strongest text.
    const Ls = steps.slice(1).map((s) => s[0]);
    const dir = Math.sign(Ls[Ls.length - 1] - Ls[0]);
    for (let i = 1; i < Ls.length; i++) expect(Math.sign(Ls[i] - Ls[i - 1])).toBe(dir);
  });

  it("matches the OKLCH values documented next to each step", () => {
    for (const body of [block(":root"), darkBody]) {
      for (const m of body.matchAll(/--gray-(\d+):\s*(#[0-9a-f]{6});\s*\/\* oklch\(([\d.]+)% ([\d.]+) (\d+)\) \*\//g)) {
        const [L, C] = oklch(hexToRgb(m[2]));
        expect(Math.abs(L * 100 - Number(m[3]))).toBeLessThan(0.6);
        expect(Math.abs(C - Number(m[4]))).toBeLessThan(0.0025);
      }
    }
  });

  it("maps roles onto the documented steps", () => {
    const map: Record<string, number> = { "--desk": 1, "--surface": 2, "--surface-2": 3, "--zebra": 3, "--chrome": 3, "--hover": 4, "--hairline": 5, "--border": 6, "--field-border": 8, "--muted": 9, "--text-2": 11, "--text": 12 };
    for (const [role, step] of Object.entries(map)) expect(light[role]).toBe(`var(--gray-${step})`);
  });
});

describe("the System copies", () => {
  it("repeats the Dark block exactly inside prefers-color-scheme", () => {
    expect(parse(mediaDark)).toEqual(parse(darkBody));
  });
  it("repeats Increase contrast exactly inside prefers-contrast", () => {
    expect(mediaMore).toEqual(more);
  });
});

// ── Every stylesheet (2.1, docs/ACCESSIBILITY.md; ledger WF-611) ──────────────────────────────
// The pairs above are the ones the interface was designed around. The views added since (Welcome,
// the tour, problems, scenarios, animation, the Results views) set colours in their own sheets:
// every rule under src/ that paints text and its own background from tokens is a pair too, and is
// held to AA in all four themes. A rule whose colours are not both plain tokens (transparent,
// inherit, a gradient) is not a pair and is skipped; a disabled control is exempt (WCAG 1.4.3).
import { declarations } from "./colour-policy.test";
import { sheets } from "./sheets";

const tokenOf = (value: string): string | null => {
  const v = value.replace(/\s*!important\s*$/, "").trim();
  if (/^var\(--[\w-]+\)$/.test(v) || /^color-mix\(in srgb,/.test(v) || /^#[0-9a-f]{3,8}$/i.test(v)) return v;
  return null;
};

interface RulePair {
  where: string;
  fg: string;
  bg: string;
}

function rulePairs(): RulePair[] {
  const byRule = new Map<string, { fg?: string; bg?: string }>();
  for (const [file, text] of Object.entries(sheets)) {
    for (const d of declarations(file, text)) {
      if (/:disabled|\[disabled\]|aria-disabled|::selection|::placeholder|\.xterm|shell-classic/.test(d.selector)) continue;
      const key = `${d.file}:${d.selector}`;
      const entry = byRule.get(key) ?? {};
      if (d.prop === "color") entry.fg = d.value;
      if (d.prop === "background" || d.prop === "background-color") entry.bg = d.value;
      byRule.set(key, entry);
    }
  }
  const out: RulePair[] = [];
  for (const [where, { fg, bg }] of byRule) {
    const f = fg && tokenOf(fg);
    const b = bg && tokenOf(bg);
    if (f && b) out.push({ where, fg: f, bg: b });
  }
  return out;
}

const PAIRED = rulePairs();

function ratioOf(t: Tokens, fg: string, bg: string): number | null {
  try {
    const la = luminance(resolve(t, fg));
    const lb = luminance(resolve(t, bg));
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  } catch {
    // A token defined outside styles.css's root blocks (a canvas or shell colour): not this test's.
    return null;
  }
}

describe("text on its own background, in every stylesheet", () => {
  it("finds the rules", () => {
    expect(PAIRED.length).toBeGreaterThan(40);
  });
  it.each([
    ["light", light],
    ["dark", dark],
    ["light, increased contrast", { ...light, ...more }],
    ["dark, increased contrast", { ...dark, ...more }],
  ])("is at least 4.5:1 (%s)", (_name, t) => {
    const failures = PAIRED.map((p) => ({ ...p, ratio: ratioOf(t, p.fg, p.bg) }))
      .filter((p) => p.ratio !== null && p.ratio < 4.5)
      .map((p) => `${p.where} { color: ${p.fg}; background: ${p.bg} } is ${p.ratio!.toFixed(2)}:1`);
    expect(failures).toEqual([]);
  });
});

describe("inks stay inks", () => {
  // --sel-muted is the secondary text of a selected row. It was once used as a row's background
  // (a dark grey bar under near-black text, 1.9:1): a text token never paints a ground.
  it("no rule paints a background with a text token", () => {
    const inks = /var\(--(text|text-2|sel-text|sel-muted)\)/;
    const bad = Object.entries(sheets).flatMap(([file, text]) =>
      declarations(file, text)
        .filter((d) => (d.prop === "background" || d.prop === "background-color") && inks.test(d.value) && !/color-mix/.test(d.value))
        .map((d) => `${d.file}:${d.line} ${d.selector} { ${d.prop}: ${d.value} }`),
    );
    expect(bad).toEqual([]);
  });
  it("every search box that hides its input's ring draws one itself", () => {
    const boxes = Object.entries(sheets).flatMap(([file, text]) =>
      declarations(file, text)
        .filter((d) => d.prop === "outline" && /^(none|0)$/.test(d.value) && /^\.[\w-]+ input(:focus(-visible)?)?$/.test(d.selector))
        .map((d) => ({ file, box: d.selector.split(" ")[0] }))
        // The command palette is one field in a modal of its own: the caret is its focus mark.
        .filter((b) => b.box !== ".palette-field"),
    );
    expect(boxes.length).toBeGreaterThan(2);
    for (const { file, box } of boxes) expect(css.includes(`${box}:focus-within`) || sheets[file].includes(`${box}:focus-within`), `${file} ${box}`).toBe(true);
  });
});

describe("the focus ring on a selected row", () => {
  // Under Increase Contrast the selection is a solid dark fill, where the ring takes --sel-text
  // (outline.css); in the plain themes the ring itself must show on the selection.
  it.each([["light", light], ["dark", dark]] as const)("is 3:1 on --sel (%s)", (_n, t) => {
    expect(ratio(t, "--focus-ring", "--sel")).toBeGreaterThanOrEqual(3);
  });
  it("is --sel-text on the solid selection, which is 7:1", () => {
    for (const t of [{ ...light, ...more }, { ...dark, ...more }]) expect(ratio(t, "--sel-text", "--sel")).toBeGreaterThanOrEqual(7);
    expect(sheets["src/canvas/outline/outline.css"]).toContain("outline-color: var(--sel-text)");
  });
});

// The marks and text the newer views lean on, on every ground they are drawn on.
const NEW_PAIRS: [string, string, number][] = [
  // Welcome cards, the tour callout and the scenarios bar sit on --surface-2 / --surface-3 / --chrome.
  ["--text", "--surface-2", 7],
  ["--text", "--surface-3", 7],
  ["--text-2", "--surface-2", 4.5],
  ["--text-2", "--surface-3", 4.5],
  ["--muted", "--zebra", 4.5],
  ["--accent-text", "--surface-2", 4.5],
  ["--accent-text", "--hover", 4.5],
  // A selected row's secondary text (the Results history, the Canvas Outline).
  ["--sel-muted", "--sel", 4.5],
  ["--text-2", "--sel-inactive", 4.5],
  // Severity words and verdicts on the tinted grounds and on a hovered row.
  ["--crit-text", "--surface-2", 4.5],
  ["--warn-text", "--surface-2", 4.5],
  ["--good-text", "--surface-2", 4.5],
  ["--crit-text", "--hover", 4.5],
  ["--warn-text", "--hover", 4.5],
  // Problem glyphs and badges: a graphic needs 3:1 against what is next to it.
  ["--critical", "--surface-2", 3],
  ["--warn-text", "--warn-bg", 3],
  ["--info", "--surface", 3],
  ["--good", "--surface", 3],
  // The focus ring on every ground a focused control can sit on, and the accent as a mark.
  ["--focus-ring", "--surface-2", 3],
  ["--focus-ring", "--chrome", 3],
  ["--focus-ring", "--desk", 3],
  ["--accent", "--surface", 3],
  ["--accent", "--surface-2", 3],
  // Tier and series marks (charts, the Agreement view, the scenario table, animation tokens) on the chrome too.
  ...["exact", "simulation", "approximation", "diffusion", "bound"].map((t): [string, string, number] => [`--tier-${t}`, "--chrome", 3]),
  ...Array.from({ length: 8 }, (_, i): [string, string, number] => [`--series-${i + 1}`, "--chrome", 3]),
];

const chartTokens = (theme: "light" | "dark"): Tokens => {
  const start = css.indexOf("/* ---------- Charts (2.1");
  const end = css.indexOf("/* ---------- end Charts, Increase Contrast");
  const text = css.slice(start, end);
  const lightBlock = parse(text.slice(text.indexOf(":root {"), text.indexOf(':root[data-theme="dark"]')));
  const moreStart = text.indexOf("/* ---------- Charts, Increase Contrast");
  const moreText = text.slice(moreStart);
  const lightMore = parse(moreText.slice(moreText.indexOf(":root {"), moreText.indexOf(':root[data-theme="dark"]')));
  const darkOf = (s: string) => parse(s.slice(s.indexOf(':root[data-theme="dark"]'), s.indexOf("@media")));
  return theme === "light" ? { ...lightBlock, ...lightMore } : { ...lightBlock, ...lightMore, ...darkOf(text.slice(0, moreStart)), ...darkOf(moreText) };
};
const chartMore: Tokens = Object.fromEntries([...["exact", "simulation", "approximation", "diffusion", "bound"].map((t) => `--tier-${t}`), ...Array.from({ length: 8 }, (_, i) => `--series-${i + 1}`)].map((n) => [n, `var(${n}-more)`]));

describe.each([
  ["light", { ...light, ...chartTokens("light") }],
  ["dark", { ...dark, ...chartTokens("dark") }],
  ["light, increased contrast", { ...light, ...chartTokens("light"), ...more, ...chartMore }],
  ["dark, increased contrast", { ...dark, ...chartTokens("dark"), ...more, ...chartMore }],
])("%s: the pairs the 2.1 views add", (_name, t) => {
  it.each(NEW_PAIRS)("%s on %s ≥ %s:1", (fg, bg, min) => {
    expect(ratio(t, fg, bg)).toBeGreaterThanOrEqual(min);
  });
});
