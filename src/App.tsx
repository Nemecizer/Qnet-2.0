// The main window: the top bar (the window's drag region, with the traffic lights at its left, the
// title and the workspace toolbar), the panes (src/workspace/Workspace.tsx) and the status bar,
// with the overlays (command palette, alerts, toasts) and the windows that live as long as the app
// (Settings). Each area registers its commands here; the menu bar is built from them
// (src/lib/menu.ts, laid out by src/lib/menuSpec.ts).
import { useEffect, useState } from "react";
import { appearanceCommands } from "./lib/appearanceCommands";
import { installRadioGroups } from "./lib/radiogroups";
import { Command as CommandIcon } from "lucide-react";
import { CommandPalette } from "./components/CommandPalette";
import { DialogHost } from "./components/DialogHost";
import { Toasts } from "./components/Toasts";
import { api, inTauri } from "./lib/api";
import { runCommand, useCommands, getCommand } from "./lib/commands";
import { loadKv } from "./lib/kv";
import { installPreviewKeys, startMenu, useMenuSync } from "./lib/menu";
import { togglePalette } from "./lib/overlays";
import type { AppInfo, PersistenceWarning } from "./lib/types";
import { APP_NAME, versionLabel, words } from "./lib/vocabulary";
import { useStatusCommands } from "./panes/status";
import { SettingsHost, useSettingsCommands } from "./windows/settings";
import { FilesHost, useFileCommands } from "./workspace/files";
import { useEditCommands } from "./editor/commands";
import { ExportPanelHost, useExportCommands } from "./canvas/export";
import { useNetworkCommands } from "./network";
import { useClosedCommands } from "./closed";
import { ArchetypeGalleryHost } from "./windows/archetypes";
import { ParametersHost } from "./windows/parameters";
import { AnalysisHost, useAnalysisCommands, useStartupDependencyCheck } from "./analysis";
import { RunPanelsHost, useRunCommands } from "./runs/ui";
import { adoptActiveRun } from "./runs/state";
import { HelpHosts, useHelpCommands } from "./windows/help";
import { FailureReportHost, useReportCommands } from "./runs/reports";
import { FitHost } from "./fit";
import { SweepHost } from "./sweeps";
import { TourHost } from "./tour";
import { UpdateHost, useUpdateCommands } from "./updates";
import { TabsHost, useTabCommands, WindowTitle } from "./workspace/tabs";
import { usePaneCommands, Workspace, WorkspaceToolbar } from "./workspace/Workspace";
import { useWelcomeCommands, WelcomeHost } from "./welcome";
import "./workspace/workspace.css";

/** Commands that belong to the app rather than one area. */
function useAppCommands() {
  useCommands(
    [{ id: "view:command-palette", title: "Command Palette…", group: "View", icon: CommandIcon, keywords: ["search", "commands"], run: () => togglePalette() }, ...appearanceCommands()],
    [],
  );
  // ⌘? can't be a menu key (Shift-/ types "?", which AppKit won't match), so the page opens Help.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Slash" && e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey && getCommand("help:open")) {
        e.preventDefault();
        void runCommand("help:open");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [setAside, setSetAside] = useState<PersistenceWarning[]>([]);

  useEffect(() => {
    let alive = true;
    api.appInfo().then((i) => alive && setInfo(i), () => {});
    api.persistenceWarnings().then((w) => alive && setSetAside(w), () => {});
    loadKv().catch(() => {});
    // A run Rust is still doing (this page was reloaded mid-run) shows in the run segment.
    void adoptActiveRun();
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => startMenu(), []);
  // Arrow keys and one Tab stop for every segmented control (src/lib/radiogroups.ts).
  useEffect(() => installRadioGroups(document), []);
  useEffect(() => installPreviewKeys(), []);
  useMenuSync();
  useAppCommands();
  useTabCommands();
  useFileCommands();
  useEditCommands();
  useExportCommands();
  useNetworkCommands();
  useClosedCommands();
  useAnalysisCommands();
  useRunCommands();
  useHelpCommands();
  useReportCommands();
  useStartupDependencyCheck();
  usePaneCommands();
  useStatusCommands();
  useSettingsCommands();
  useWelcomeCommands();
  useUpdateCommands();

  return (
    <div className="app">
      <header className="topbar" data-tauri-drag-region>
        <WindowTitle />
        <span className="spacer" data-tauri-drag-region />
        <WorkspaceToolbar />
      </header>
      <main className="work" aria-label="Workspace">
        {setAside.map((w) => (
          <div key={w.path} className="notice" role="status">
            {words.setAside(w.file, w.backup)}
          </div>
        ))}
        <Workspace />
        <WelcomeHost />
        <Toasts />
      </main>
      <footer className="statusbar">
        <span>{info ? `${APP_NAME} ${versionLabel(info.version, info.instance, info.buildTag)}` : APP_NAME}</span>
        <span className="spacer" />
        {!inTauri || info === null ? null : <span>{info.identifier}</span>}
      </footer>
      <TabsHost />
      <FilesHost />
      <SettingsHost />
      <ExportPanelHost />
      <ArchetypeGalleryHost />
      <ParametersHost />
      <AnalysisHost />
      <RunPanelsHost />
      <HelpHosts />
      <FailureReportHost />
      <SweepHost />
      <FitHost />
      <TourHost />
      <UpdateHost />
      <CommandPalette />
      <DialogHost />
    </div>
  );
}
