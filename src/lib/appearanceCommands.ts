// View ▸ Appearance (new in 2.1, ledger WF-612; ids as src/lib/menuSpec.ts names them). The theme,
// Increase Contrast, Reduce Motion and the text size were kept by src/lib/theme.ts and followed
// macOS, but nothing in the interface could set them: a reader who needs larger text had no way to
// ask for it. These are check items over that same store; nothing else changes.
import { shellWords } from "../components/words";
import type { Command } from "./commands";
import { invalidateMenu } from "./menu";
import { getAppearance, setAppearance as store, TEXT_SCALES, type Appearance, type ThemePref } from "./theme";

const w = shellWords.appearance;
/** Sets it and has the menu bar redraw its check marks. */
function setAppearance(patch: Partial<Appearance>) {
  store(patch);
  invalidateMenu();
}
const THEMES: ThemePref[] = ["system", "light", "dark"];
/** "0.92" → "92": the id's last part. */
const scaleId = (value: number) => String(Math.round(value * 100));

export const APPEARANCE_COMMANDS = {
  theme: (t: ThemePref) => `view:appearance-${t}`,
  contrast: "view:increase-contrast",
  motion: "view:reduce-motion",
  textSize: (value: number) => `view:text-size-${scaleId(value)}`,
} as const;

export function appearanceCommands(): Command[] {
  const keywords = [...w.keywords];
  return [
    ...THEMES.map((t): Command => ({ id: APPEARANCE_COMMANDS.theme(t), title: `${w.menu}: ${w.theme[t]}`, group: "View", keywords, subtitle: w.themeHelp[t], checked: () => getAppearance().theme === t, run: () => setAppearance({ theme: t }) })),
    {
      id: APPEARANCE_COMMANDS.contrast,
      title: w.contrast,
      group: "View",
      keywords,
      subtitle: w.contrastHelp,
      checked: () => getAppearance().contrast === "more",
      run: () => setAppearance({ contrast: getAppearance().contrast === "more" ? "system" : "more" }),
    },
    {
      id: APPEARANCE_COMMANDS.motion,
      title: w.motion,
      group: "View",
      keywords,
      subtitle: w.motionHelp,
      checked: () => getAppearance().motion === "reduce",
      run: () => setAppearance({ motion: getAppearance().motion === "reduce" ? "system" : "reduce" }),
    },
    ...TEXT_SCALES.map((s): Command => ({ id: APPEARANCE_COMMANDS.textSize(s.value), title: w.textSize[s.value], group: "View", keywords, subtitle: w.textSizeHelp, checked: () => getAppearance().textScale === s.value, run: () => setAppearance({ textScale: s.value }) })),
  ];
}
