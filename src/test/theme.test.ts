import { describe, expect, it, vi } from "vitest";
import { APPEARANCE_KEY, getAppearance, onThemeChange, setAppearance, setThemePref } from "../lib/theme";
import { APPEARANCE_KEY_FOR_PREVIEW } from "../dev/mockShared";
import { mockCalls, mockTauri } from "./tauri";

describe("appearance", () => {
  it("sets the document attributes, saves the choice and tells the native window", async () => {
    mockTauri({});
    const seen = vi.fn();
    const off = onThemeChange(seen);
    setThemePref("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(JSON.parse(localStorage.getItem("qnet.appearance")!).theme).toBe("dark");
    expect(seen).toHaveBeenCalledWith({ pref: "dark", effective: "dark" });
    await Promise.resolve();
    expect(mockCalls.find((c) => c.cmd === "plugin:window|set_theme")?.args).toMatchObject({ value: "dark" });

    setAppearance({ theme: "system", textScale: 1.12, contrast: "more", motion: "reduce" });
    const root = document.documentElement;
    expect(root.hasAttribute("data-theme")).toBe(false);
    expect(root.getAttribute("data-contrast")).toBe("more");
    expect(root.getAttribute("data-motion")).toBe("reduce");
    expect(root.style.getPropertyValue("--text-scale")).toBe("1.12");
    expect(seen).toHaveBeenLastCalledWith({ pref: "system", effective: "light" });
    off();

    setAppearance({ textScale: 1, contrast: "system", motion: "system" });
    expect(root.style.getPropertyValue("--text-scale")).toBe("");
    expect(getAppearance()).toEqual({ theme: "system", textScale: 1, motion: "system", contrast: "system" });
  });

  it("keeps the browser preview, index.html and mock.html on the same storage key", async () => {
    expect(APPEARANCE_KEY_FOR_PREVIEW).toBe(APPEARANCE_KEY);
    const html = await import("../../index.html?raw");
    const mock = await import("../../mock.html?raw");
    for (const page of [html.default, mock.default]) expect(page).toContain(`localStorage.getItem("${APPEARANCE_KEY}")`);
  });
});
