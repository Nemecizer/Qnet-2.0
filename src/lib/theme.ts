// Appearance: theme (System / Light / Dark), text size, reduced motion and increased contrast
// (NetMon's theme module without the Black theme and the chart colour helpers). The choice lives
// in localStorage['qnet.appearance']; index.html applies it before the first paint and this
// module keeps <html>'s data-theme / data-contrast / data-motion and --text-scale in step with
// it. Changing the theme also sets the native window's appearance, so the macOS title bar and
// menus follow.
import { useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type ThemePref = "system" | "light" | "dark";
export type Effective = "light" | "dark";

export interface Appearance {
  theme: ThemePref;
  /** Multiplies every font-size token: 0.92, 1, 1.12, 1.25 or 1.5. */
  textScale: number;
  motion: "system" | "reduce";
  contrast: "system" | "more";
}

export const TEXT_SCALES: { value: number; label: string }[] = [
  { value: 0.92, label: "Small" },
  { value: 1, label: "Default" },
  { value: 1.12, label: "Large" },
  { value: 1.25, label: "Larger" },
  // 2.1 (ledger FIX-108): one more step, half as large again. The window's minimum size stays, so
  // in a small window the dense bars scroll or shorten their labels (docs/ACCESSIBILITY.md §6).
  { value: 1.5, label: "Largest" },
];

export const APPEARANCE_KEY = "qnet.appearance";
const DEFAULTS: Appearance = { theme: "system", textScale: 1, motion: "system", contrast: "system" };
const THEME_EVENT = "qnet:theme";

function load(): Appearance {
  try {
    const raw = JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? "{}") as Partial<Appearance>;
    return {
      theme: raw.theme === "light" || raw.theme === "dark" ? raw.theme : "system",
      textScale: TEXT_SCALES.some((s) => s.value === raw.textScale) ? raw.textScale! : 1,
      motion: raw.motion === "reduce" ? "reduce" : "system",
      contrast: raw.contrast === "more" ? "more" : "system",
    };
  } catch {
    return { ...DEFAULTS };
  }
}

const darkQuery: MediaQueryList | null = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

let appearance = load();
let themeSnap = computeTheme();
const listeners = new Set<() => void>();

function computeTheme(): { pref: ThemePref; effective: Effective } {
  const effective: Effective = appearance.theme === "system" ? (darkQuery?.matches ? "dark" : "light") : appearance.theme;
  return { pref: appearance.theme, effective };
}

function applyToDocument(a: Appearance) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const attr = (name: string, value: string | null) => (value ? root.setAttribute(name, value) : root.removeAttribute(name));
  attr("data-theme", a.theme === "system" ? null : a.theme);
  attr("data-contrast", a.contrast === "more" ? "more" : null);
  attr("data-motion", a.motion === "reduce" ? "reduce" : null);
  if (a.textScale === 1) root.style.removeProperty("--text-scale");
  else root.style.setProperty("--text-scale", String(a.textScale));
}

/** Points the native window (title bar, menus, scroll bars) at the same theme. */
function applyToWindow(pref: ThemePref) {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  try {
    getCurrentWindow().setTheme(pref === "system" ? null : pref).catch(() => {
      // A build without the set-theme permission keeps the system look.
    });
  } catch {
    // No native window (tests, the browser preview).
  }
}

function notify(themeChanged: boolean) {
  const next = computeTheme();
  const effectiveChanged = next.effective !== themeSnap.effective || next.pref !== themeSnap.pref;
  if (effectiveChanged) themeSnap = next;
  listeners.forEach((l) => l());
  if (themeChanged || effectiveChanged) window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: themeSnap }));
}

darkQuery?.addEventListener?.("change", () => {
  if (appearance.theme === "system") notify(true);
});

applyToDocument(appearance);
if (appearance.theme !== "system") applyToWindow(appearance.theme);

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getAppearance(): Appearance {
  return appearance;
}

export function setAppearance(patch: Partial<Appearance>) {
  const next = { ...appearance, ...patch };
  const themeChanged = next.theme !== appearance.theme;
  appearance = next;
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(next));
  } catch {
    // Not persisted (private storage); it still applies for this session.
  }
  applyToDocument(next);
  if (themeChanged) applyToWindow(next.theme);
  notify(themeChanged);
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, getAppearance);
}

export function setThemePref(pref: ThemePref) {
  setAppearance({ theme: pref });
}

export function useTheme(): { pref: ThemePref; effective: Effective } {
  return useSyncExternalStore(subscribe, () => themeSnap);
}

/** True while the effective theme is dark (System following macOS, or Dark chosen). */
export function useDarkMode(): boolean {
  return useTheme().effective === "dark";
}

/** Runs `cb` whenever the effective theme changes; canvas drawing redraws with it. */
export function onThemeChange(cb: (t: { pref: ThemePref; effective: Effective }) => void): () => void {
  const h = (e: Event) => cb((e as CustomEvent<{ pref: ThemePref; effective: Effective }>).detail);
  window.addEventListener(THEME_EVENT, h);
  return () => window.removeEventListener(THEME_EVENT, h);
}

/** Reads a CSS custom property, for drawing that can't use var(). */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
