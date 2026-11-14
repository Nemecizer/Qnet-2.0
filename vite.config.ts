/// <reference types="vitest/config" />
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev port and leaves src-tauri to cargo's watcher. Qnet's ports (1440 for
// Tauri, 1450 for the preview) are its own, so it runs beside SparkBox and NetMon (1420/1430).
// `npm run dev:mock` serves the same tree; mock.html runs the UI against the simulated backend in
// src/dev, so it works in any browser.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1440, strictPort: true, watch: { ignored: ["**/src-tauri/**", "**/solvers/**", "**/golden/**"] } },
  build: {
    // Outside Dropbox: the bundler copies from here (see scripts/stage-build.sh).
    outDir: join(homedir(), "Library/Caches/qnet/dist"),
    emptyOutDir: true,
    rollupOptions: { input: { main: resolve(import.meta.dirname, "index.html") } },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // Keep stylesheet contents, so contrast.test.ts and colour-policy.test.ts can read every
    // one of them with ?raw (Vitest blanks CSS by default).
    css: { include: [/\.css(\?|$)/] },
    restoreMocks: true,
  },
});
