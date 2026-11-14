// The Shell's colours come from the Shell block of tokens in src/styles.css (SH-062…064, SH-043).
import { describe, expect, it } from "vitest";
import css from "../../styles.css?raw";
import { shellTheme } from "./theme";

const LIGHT = ["#000000", "#b20000", "#008000", "#996600", "#0000cc", "#990099", "#008099", "#999999", "#666666", "#cc0000", "#009900", "#b28600", "#3333ff", "#cc00cc", "#0099b2", "#b2b2b2"];
const DARK = ["#606060", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5", "#808080", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"];

function rootWith(vars: Record<string, string>): HTMLElement {
  const el = document.createElement("div");
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
  document.body.appendChild(el);
  return el;
}

describe("the Shell's theme", () => {
  it("keeps 0.90.34's palettes and classic colours as tokens, dark in both dark blocks", () => {
    const block = css.slice(css.indexOf("/* ---------- Shell"), css.indexOf("/* ---------- end Shell"));
    LIGHT.forEach((c, i) => expect(block).toContain(`--shell-ansi-${i}: ${c};`));
    DARK.forEach((c, i) => expect(block).toContain(`--shell-ansi-dark-${i}: ${c};`));
    // sRGB(0.30, 0.90, 0.40) on black; selection green at 35 %.
    expect(block).toContain("--shell-classic-fg: #4de666;");
    expect(block).toContain("--shell-classic-bg: #000000;");
    expect(block).toContain("--shell-classic-sel: rgba(77, 230, 102, 0.35);");
    const dark = block.slice(block.indexOf(':root[data-theme="dark"]'));
    expect(dark.match(/--shell-ansi-1: #cd3131;/g)).toHaveLength(2);
  });

  it("system: the app's text on its surface, the accent caret, the selection colour; classic: green on black", () => {
    const vars: Record<string, string> = { "--shell-fg": "#111111", "--shell-bg": "#fefefe", "--shell-caret": "#186bc5", "--shell-sel": "#cee3ff", "--shell-classic-fg": "#4de666", "--shell-classic-bg": "#000000", "--shell-classic-sel": "rgba(77, 230, 102, 0.35)" };
    LIGHT.forEach((c, i) => (vars[`--shell-ansi-${i}`] = c));
    DARK.forEach((c, i) => (vars[`--shell-ansi-dark-${i}`] = c));
    const root = rootWith(vars);
    expect(shellTheme(false, root)).toMatchObject({ foreground: "#111111", background: "#fefefe", cursor: "#186bc5", selectionBackground: "#cee3ff", red: "#b20000", brightWhite: "#b2b2b2" });
    expect(shellTheme(true, root)).toMatchObject({ foreground: "#4de666", background: "#000000", cursor: "#4de666", selectionBackground: "rgba(77, 230, 102, 0.35)", red: "#cd3131", brightWhite: "#ffffff" });
  });
});
