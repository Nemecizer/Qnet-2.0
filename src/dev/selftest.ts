// The debug build's self-test (src-tauri/src/windows.rs `selftest`, run with QNET_SELFTEST=aux):
// opens an auxiliary window, renders into it from this window's React, checks it shares this
// realm and got the stylesheets, installs the menu bar, and reports in the window's title.
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { getCommand, runCommand, titleOf } from "../lib/commands";
import { resolveMenu } from "../lib/menu";
import { auxWindow } from "../lib/auxWindow";
import { paneState } from "../panes/status/state";
import { addTab, getWorkspace, removeTabs, tabById } from "../workspace/store";
import { closeDependencyCheck } from "../analysis/deps";
import { activeEditor } from "../editor";
import { copyAsImage } from "../canvas/export";
import { onRunFinished, onRunOutput, startRun } from "../runs/state";
import { api, invoke } from "../lib/api";
import { getSetting, setSettings } from "../lib/kv";
import { closeHelp, HELP_WINDOW, openHelp } from "../windows/help/state";
import { ABOUT_WINDOW, closeAbout, openAbout } from "../windows/about";
import { cancelRequest, conversationOf, submit, whenIdle } from "../panes/ai/model";

export function installSelfTest() {
  (window as unknown as { __qnetSelfTest: () => Promise<void> }).__qnetSelfTest = async () => {
    const checks: string[] = [];
    const fail: string[] = [];
    const check = (name: string, ok: boolean) => (ok ? checks : fail).push(name);
    try {
      await invoke("menu_set", { menu: resolveMenu() });
      check("menu", true);
    } catch (e) {
      fail.push(`menu: ${String(e)}`);
    }
    const win = window.open("about:blank#aux=selftest&minw=300&minh=200", "qnet-selftest", "width=420,height=300");
    if (!win) {
      document.title = "SELFTEST FAIL window.open returned null";
      return;
    }
    await new Promise((r) => setTimeout(r, 800));
    let report = "";
    try {
      const doc = win.document;
      check("same-origin", !!doc.body);
      document.head.querySelectorAll("style, link[rel=stylesheet]").forEach((n) => doc.head.appendChild(n.cloneNode(true)));
      const host = doc.createElement("div");
      doc.body.appendChild(host);
      createRoot(host).render(createElement("span", { id: "probe" }, "rendered"));
      await new Promise((r) => setTimeout(r, 300));
      check("react", doc.getElementById("probe")?.textContent === "rendered");
      check("styles", doc.head.querySelectorAll("style, link").length > 0);
      let clicked = false;
      doc.getElementById("probe")?.addEventListener("click", () => (clicked = true));
      doc.getElementById("probe")?.dispatchEvent(new (win as unknown as typeof globalThis).MouseEvent("click", { bubbles: true }));
      check("events", clicked);
      // A detached pane is the main window's own React tree moved into another window: typing in
      // the detached Status pane's search field must reach the main window's state.
      await runCommand("view:detach-status");
      await new Promise((r) => setTimeout(r, 1500));
      const pane = auxWindow("pane-status")?.win;
      const field = pane?.document.querySelector<HTMLInputElement>('[data-pane="status"] input');
      check("detached-pane", !!field);
      if (pane && field) {
        const setter = Object.getOwnPropertyDescriptor((pane as unknown as typeof globalThis).HTMLInputElement.prototype, "value")!.set!;
        setter.call(field, "probe");
        field.dispatchEvent(new (pane as unknown as typeof globalThis).Event("input", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 200));
        check("detached-events", paneState(getWorkspace().activeId).search === "probe");
      }
      await runCommand("view:reattach-all");
      await new Promise((r) => setTimeout(r, 500));
      check("reattached", !auxWindow("pane-status"));
      // P5: a network built through the editor is drawn by the real canvas in WebKit, ⌘Z's command
      // takes the last step back, a parameters panel opens as a window of its own, and Copy as
      // Image reaches the pasteboard (Rust prints the pasteboard's types after the report).
      // In a tab of its own, closed afterwards, so the dev session never keeps the test network.
      // A development build opens the dependency checklist at launch (document-modal, so ⌘Z waits
      // under it, MENU-198): let it finish and close it first.
      for (let i = 0; i < 200 && !closeDependencyCheck(); i++) await new Promise((r) => setTimeout(r, 100));
      const testTab = addTab({ title: "Self-test" });
      await new Promise((r) => setTimeout(r, 300));
      const e = activeEditor();
      e.setTool("addSource");
      e.handleCanvasTap({ x: 120, y: 200 });
      await new Promise((r) => setTimeout(r, 30));
      e.setTool("addStation");
      e.handleCanvasTap({ x: 260, y: 200 });
      await new Promise((r) => setTimeout(r, 30));
      e.setTool("addSink");
      e.handleCanvasTap({ x: 400, y: 200 });
      await new Promise((r) => setTimeout(r, 30));
      e.addLink(e.nodes[0].id, e.nodes[1].id);
      await new Promise((r) => setTimeout(r, 30));
      e.addLink(e.nodes[1].id, e.nodes[2].id);
      e.setTool("select");
      await new Promise((r) => setTimeout(r, 400));
      const canvas = document.querySelector('[data-pane="canvas"] [data-layer="nodes"]')?.closest("svg") ?? null;
      const nBodies = canvas?.querySelectorAll('[data-layer="nodes"] [data-part="body"]').length ?? -1;
      if (nBodies !== 3) fail.push(`canvas-nodes: ${nBodies} bodies, ${e.nodes.length} nodes, ${document.querySelectorAll('[data-layer="nodes"]').length} node layers, tab ${e.tabId === getWorkspace().activeId}`);
      else checks.push("canvas-nodes");
      const nLinks = canvas?.querySelectorAll("[data-link]").length ?? -1;
      if (nLinks !== 2) fail.push(`canvas-links: ${nLinks} drawn, ${e.links.length} links`);
      else checks.push("canvas-links");
      check("undo-title", getCommand("edit:undo") ? titleOf(getCommand("edit:undo")!) === "Undo Add Link" : false);
      await runCommand("edit:undo");
      await new Promise((r) => setTimeout(r, 200));
      check("undo", e.links.length === 1 && (canvas?.querySelectorAll("[data-link]").length ?? 0) === 1);
      e.openParameterEditor(e.nodes[1].id);
      await new Promise((r) => setTimeout(r, 1500));
      const panel = auxWindow("panel-node-parameters")?.win;
      check("node-panel", !!panel?.document.querySelector("form.insp-form"));
      e.closeParameterEditor();
      await new Promise((r) => setTimeout(r, 500));
      check("node-panel-closed", !auxWindow("panel-node-parameters"));
      check("copy-as-image", await copyAsImage(e));
      // P6: the user's shell is up in the Shell pane, and a quick method runs end to end for each
      // buffer mode: the solver's output reaches the Shell, and a record is filed for this tab.
      check("shell", !!document.querySelector('[data-pane="shell"] .xterm'));
      e.addLink(e.nodes[1].id, e.nodes[2].id);
      await new Promise((r) => setTimeout(r, 50));
      const runOnce = async (method: string) => {
        let bytes = 0;
        const stopOut = onRunOutput((b) => (bytes += b.length));
        const done = new Promise<{ filed: string | null; summary: string }>((resolve) => {
          const stop = onRunFinished((m) => {
            stop();
            resolve({ filed: m.filed, summary: m.summary });
          });
        });
        const started = await startRun(testTab, method);
        const end = started ? await Promise.race([done, new Promise<null>((r) => setTimeout(() => r(null), 60_000))]) : null;
        stopOut();
        const records = await api.resultsList(testTab);
        const filed = records.filter((r) => r.method).map((r) => r.status);
        const ok = !!end && bytes > 0 && filed.length > 0;
        const said = started ? "" : `; ${(tabById(testTab)?.log ?? []).slice(-2).map((l) => l.text).join(" / ")}`;
        (ok ? checks : fail).push(`run-${method}(${end?.filed ?? "not started"}; ${bytes} bytes; ${end?.summary ?? ""}${said})`);
        return records;
      };
      e.setInfiniteBuffers(true);
      await new Promise((r) => setTimeout(r, 300));
      await runOnce("qna");
      // Finite buffers: a buffer in front of the station (Src → B1 → S1 → Sink).
      e.setInfiniteBuffers(false);
      const b1 = e.addNode("buffer", { x: 190, y: 200 });
      e.deleteLink(e.links[0].id);
      e.addLink(e.nodes[0].id, b1.id);
      e.addLink(b1.id, e.nodes[1].id);
      await new Promise((r) => setTimeout(r, 300));
      await runOnce("fb_decomp");
      for (const r of await api.resultsList(testTab)) await api.resultsDelete(r.id);
      removeTabs([testTab]);
      // P7: Help opens on an article and About opens, each as a window of its own; and when an
      // Ollama server is running here, the assistant is asked — through the real provider code,
      // with the real tools — to build a two-station tandem and run QNA on it (PLAN §7's
      // acceptance). What the model managed is reported; only a request that fails is a failure.
      openHelp("keyboardShortcuts");
      await new Promise((r) => setTimeout(r, 1500));
      const helpDoc = auxWindow(HELP_WINDOW)?.win.document;
      const helpPage = helpDoc?.querySelector(".help-page");
      const helpText = (helpPage?.textContent ?? "").replace(/\s+/g, " ");
      if (/keyboard shortcuts/i.test(helpText) && helpText.includes("⌘")) checks.push("help-article");
      else fail.push(`help-article: window ${!!helpDoc}, page ${!!helpPage}, text “${helpText.slice(0, 80)}”, body “${(helpDoc?.body.textContent ?? "").replace(/\s+/g, " ").slice(0, 80)}”`);
      closeHelp();
      openAbout();
      await new Promise((r) => setTimeout(r, 1200));
      check("about", (auxWindow(ABOUT_WINDOW)?.win.document.body.textContent ?? "").includes("Qnet"));
      closeAbout();
      await new Promise((r) => setTimeout(r, 800));
      // Closing must take the native window away, not only its contents.
      const { Window: NativeWindow } = await import("@tauri-apps/api/window");
      const left = (await NativeWindow.getAll()).map((w) => w.label).filter((l) => l.startsWith("aux-") && l !== "aux-selftest");
      if (left.length) fail.push(`windows-closed: still open: ${left.join(", ")}`);
      else checks.push("windows-closed");
      const OLLAMA = "http://localhost:11434";
      const models = await api.aiModels("ollama", OLLAMA).then((list) => list.map((m) => m.id)).catch(() => null);
      if (!models?.length) checks.push("assistant(no Ollama server here: not tried)");
      else {
        const model = models.find((m) => m === "qwen3.6:latest") ?? models[0];
        const keys = ["ai.provider", "ai.model.ollama", "ai.baseURL.ollama"];
        const before = Object.fromEntries(keys.map((k) => [k, getSetting<string | null>(k, null)]));
        const aiTab = addTab({ title: "Self-test assistant" });
        try {
          await setSettings({ "ai.provider": "ollama", "ai.model.ollama": model, "ai.baseURL.ollama": OLLAMA });
          await new Promise((r) => setTimeout(r, 300));
          const ed = activeEditor();
          ed.setInfiniteBuffers(true);
          let qna = false;
          const stopFinished = onRunFinished((_m, meta) => (qna ||= meta.tabId === aiTab && meta.method === "qna"));
          submit(aiTab, "Build a tandem queue on the canvas: one source, then a buffer and a single-server station, then a second buffer and a second single-server station, then a sink, linked in that order. Then run QNA on it with run_command (name RunQNA) and tell me in one sentence what it reported.");
          const capped = await Promise.race([whenIdle().then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 240_000))]);
          if (capped) cancelRequest();
          stopFinished();
          const rows = conversationOf(aiTab).messages;
          const calls = rows.filter((m) => m.call);
          const errors = rows.filter((m) => m.role === "system" && m.text.startsWith("⚠")).map((m) => m.text);
          const kinds = (k: string) => ed.nodes.filter((n) => n.kind === k).length;
          const said = `${model}; ${calls.length} tool calls (${calls.filter((m) => m.call!.isError).length} refused); ${kinds("source")} source, ${kinds("buffer")} buffers, ${kinds("station")} stations, ${kinds("sink")} sink, ${ed.links.length} links; QNA ran: ${qna ? "yes" : "no"}${capped ? "; stopped at 240 s" : ""}${errors.length ? `; ${errors.join(" / ")}` : ""}`;
          (errors.length || !calls.length ? fail : checks).push(`assistant(${said})`);
        } finally {
          await setSettings(before).catch(() => {});
          for (const r of await api.resultsList(aiTab)) await api.resultsDelete(r.id);
          removeTabs([aiTab]);
        }
      }
      report = `${checks.join(",")}${fail.length ? ` failed: ${fail.join("; ")}` : ""}`;
      doc.title = `${fail.length ? "SELFTEST FAIL" : "SELFTEST OK"} ${report}`;
    } catch (e) {
      document.title = `SELFTEST FAIL ${String(e)}`;
      win.document.title = `SELFTEST FAIL ${String(e)}`;
    }
  };
}
