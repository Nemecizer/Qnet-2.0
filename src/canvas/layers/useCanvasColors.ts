// The on-screen colour set: the current theme and Increase Contrast, as src/lib/theme.ts applies
// them to <html> (Qnet's own Appearance choice, or the macOS setting through the media query).
// 0.90.34 read `\.colorSchemeContrast` from the environment and handed it to each node view
// (NetworkCanvasView.swift `nodeView(contrast:)`); here the hook re-renders the canvas instead.
import { useSyncExternalStore } from "react";
import { useAppearance, useTheme } from "../../lib/theme";
import { canvasColors, type CanvasColors } from "./colors";

function mediaFlag(query: string): () => boolean {
  return () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false);
}

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (l) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mq = window.matchMedia(query);
      mq.addEventListener?.("change", l);
      return () => mq.removeEventListener?.("change", l);
    },
    mediaFlag(query),
    () => false,
  );
}

/** Increase Contrast: Settings › Appearance, or the system's prefers-contrast. */
export function useIncreasedContrast(): boolean {
  const a = useAppearance();
  const system = useMedia("(prefers-contrast: more)");
  return a.contrast === "more" || system;
}

/** Reduce Motion: Settings › Appearance, or the system's prefers-reduced-motion. */
export function useReducedMotion(): boolean {
  const a = useAppearance();
  const system = useMedia("(prefers-reduced-motion: reduce)");
  return a.motion === "reduce" || system;
}

/** The canvas colours for the appearance on screen now. */
export function useCanvasColors(): CanvasColors {
  const theme = useTheme().effective;
  const contrast = useIncreasedContrast();
  return canvasColors(theme, contrast);
}
