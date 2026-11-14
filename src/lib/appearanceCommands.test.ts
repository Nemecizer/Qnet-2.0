// View ▸ Appearance (ledger WF-612): the appearance settings can be reached, from the menu and the palette.
import { afterEach, describe, expect, it } from "vitest";
import { appearanceCommands, APPEARANCE_COMMANDS } from "./appearanceCommands";
import { specItem } from "./menuSpec";
import { getAppearance, setAppearance, TEXT_SCALES } from "./theme";

const run = (id: string) => appearanceCommands().find((c) => c.id === id)!.run();
const checked = (id: string) => appearanceCommands().find((c) => c.id === id)!.checked!();

afterEach(() => setAppearance({ theme: "system", contrast: "system", motion: "system", textScale: 1 }));

describe("the Appearance commands", () => {
  it("every one is a check item of the View menu, with the command's own words", () => {
    const cmds = appearanceCommands();
    expect(cmds.map((c) => c.id)).toEqual([
      "view:appearance-system", "view:appearance-light", "view:appearance-dark", "view:increase-contrast", "view:reduce-motion",
      "view:text-size-92", "view:text-size-100", "view:text-size-112", "view:text-size-125", "view:text-size-150",
    ]);
    for (const c of cmds) {
      const item = specItem(c.id);
      expect(item, c.id).toMatchObject({ check: true });
      expect(c.title.endsWith(item!.label), c.id).toBe(true);
      expect(c.subtitle, c.id).toBeTruthy();
    }
    expect(TEXT_SCALES.map((s) => APPEARANCE_COMMANDS.textSize(s.value))).toEqual(["view:text-size-92", "view:text-size-100", "view:text-size-112", "view:text-size-125", "view:text-size-150"]);
  });

  it("Increase Contrast and Reduce Motion toggle the attributes the stylesheet reads", () => {
    const root = document.documentElement;
    run(APPEARANCE_COMMANDS.contrast);
    expect([root.getAttribute("data-contrast"), checked(APPEARANCE_COMMANDS.contrast)]).toEqual(["more", true]);
    run(APPEARANCE_COMMANDS.contrast);
    expect([root.getAttribute("data-contrast"), checked(APPEARANCE_COMMANDS.contrast)]).toEqual([null, false]);
    run(APPEARANCE_COMMANDS.motion);
    expect([root.getAttribute("data-motion"), checked(APPEARANCE_COMMANDS.motion)]).toEqual(["reduce", true]);
    run(APPEARANCE_COMMANDS.motion);
    expect(root.getAttribute("data-motion")).toBeNull();
  });

  it("the text size scales every font token, and the theme can be fixed or follow the system", () => {
    const root = document.documentElement;
    run(APPEARANCE_COMMANDS.textSize(1.25));
    expect(root.style.getPropertyValue("--text-scale")).toBe("1.25");
    expect([checked(APPEARANCE_COMMANDS.textSize(1.25)), checked(APPEARANCE_COMMANDS.textSize(1))]).toEqual([true, false]);
    // The largest step is 1.5 (FIX-108), and a saved choice of it is read back.
    expect(Math.max(...TEXT_SCALES.map((t) => t.value))).toBe(1.5);
    run(APPEARANCE_COMMANDS.textSize(1.5));
    expect(root.style.getPropertyValue("--text-scale")).toBe("1.5");
    expect([checked(APPEARANCE_COMMANDS.textSize(1.5)), checked(APPEARANCE_COMMANDS.textSize(1.25))]).toEqual([true, false]);
    expect(JSON.parse(localStorage.getItem("qnet.appearance")!).textScale).toBe(1.5);
    run(APPEARANCE_COMMANDS.textSize(1));
    expect(root.style.getPropertyValue("--text-scale")).toBe("");
    run(APPEARANCE_COMMANDS.theme("dark"));
    expect([root.getAttribute("data-theme"), getAppearance().theme]).toEqual(["dark", "dark"]);
    run(APPEARANCE_COMMANDS.theme("system"));
    expect(root.getAttribute("data-theme")).toBeNull();
  });
});
