// Runs before every test file (vite.config.ts › test.setupFiles).
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { mockTauri } from "./tauri";

// jsdom has no layout engine: give components the browser APIs they expect.
if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

class ResizeObserverStub implements ResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(target: Element) {
    // Report the element's (test-assigned) width once, like a first layout pass.
    const width = (target as HTMLElement).clientWidth || 1200;
    const entry = { target, contentRect: { width, height: 400 } } as unknown as ResizeObserverEntry;
    queueMicrotask(() => this.cb([entry], this));
  }
  unobserve() {}
  disconnect() {}
}
if (typeof window.ResizeObserver === "undefined") window.ResizeObserver = ResizeObserverStub;

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
// jsdom implements element rectangles but omits Range geometry (text selection measures it):
// use the same empty layout for ranges.
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => document.createElement("span").getClientRects();
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect();

// A Tauri backend exists in every test (so `inTauri` is true); tests replace
// its handlers with mockTauri({...}).
mockTauri({});

afterEach(async () => {
  cleanup();
  // The app's module-level stores outlive a render: back to a fresh launch. Imported here, not at
  // the top, so that src/lib/api.ts first loads after mockTauri above (it reads `inTauri` once).
  const [{ resetAlerts }, { resetKv }, { resetOverlays }, { resetWorkspace }, { resetClosedTabs }, { resetSession }, { resetTabsHost }, { resetEditors }, { resetRuns }] = await Promise.all([
    import("../lib/dialogs"), import("../lib/kv"), import("../lib/overlays"), import("../workspace/store"),
    import("../workspace/tabs/closing"), import("../workspace/tabs/session"), import("../workspace/tabs/index"), import("../editor"),
    import("../runs/state"),
  ]);
  resetAlerts();
  resetOverlays();
  resetEditors();
  resetRuns();
  resetWorkspace();
  resetKv();
  resetClosedTabs();
  resetSession();
  resetTabsHost();
  // The Welcome view is back to "as at launch" (src/welcome/state.ts).
  (await import("../welcome/state")).resetWelcome();
  (await import("../canvas/outline/store")).resetOutline();
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    // Storage can be unavailable; nothing to reset then.
  }
  for (const a of ["data-theme", "data-contrast", "data-motion", "style"]) document.documentElement.removeAttribute(a);
  mockTauri({});
});
