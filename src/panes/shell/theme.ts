// The Shell's colours (TerminalConsoleView.swift `applyTheme`, DesignSystem.swift
// `shellPaletteLight` / `shellPaletteDark` / `classicShell*`, ledger SH-062…064), read from the
// Shell block of tokens in src/styles.css so they follow light, dark and increased contrast:
//
// - system (default): the app's text on its surface, the accent caret, the selection colour, and
//   0.90.34's darkened ANSI palette on a light ground or its VS Code dark palette on a dark one;
// - classic (`shell.classicTheme`): green sRGB(0.30, 0.90, 0.40) on black, a green caret, the
//   selection green at 35 %, and the dark palette.
import type { ITheme } from "@xterm/xterm";

const NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;

/** The xterm theme for the current appearance, from the tokens on `root`. */
export function shellTheme(classic: boolean, root: Element = document.documentElement): ITheme {
  const css = getComputedStyle(root);
  const v = (name: string) => css.getPropertyValue(name).trim() || undefined;
  const ansi = (i: number) => (classic ? v(`--shell-ansi-dark-${i}`) : v(`--shell-ansi-${i}`));
  const theme: ITheme = classic
    ? { foreground: v("--shell-classic-fg"), background: v("--shell-classic-bg"), cursor: v("--shell-classic-fg"), cursorAccent: v("--shell-classic-bg"), selectionBackground: v("--shell-classic-sel") }
    : { foreground: v("--shell-fg"), background: v("--shell-bg"), cursor: v("--shell-caret"), cursorAccent: v("--shell-bg"), selectionBackground: v("--shell-sel"), selectionInactiveBackground: v("--shell-sel-inactive") };
  NAMES.forEach((n, i) => {
    theme[n] = ansi(i);
  });
  for (const k of Object.keys(theme) as (keyof ITheme)[]) if (theme[k] === undefined) delete theme[k];
  return theme;
}

/** Calls `onChange` when the appearance changes (the app's theme attribute or the system's). */
export function watchAppearance(onChange: () => void, root: HTMLElement = document.documentElement): () => void {
  const mo = new MutationObserver(onChange);
  mo.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-contrast"] });
  const mqs = ["(prefers-color-scheme: dark)", "(prefers-contrast: more)"].map((q) => window.matchMedia(q));
  mqs.forEach((m) => m.addEventListener?.("change", onChange));
  return () => {
    mo.disconnect();
    mqs.forEach((m) => m.removeEventListener?.("change", onChange));
  };
}
