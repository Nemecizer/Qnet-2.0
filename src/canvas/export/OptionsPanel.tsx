// The diagram export's options (0.90.34 CanvasExportOptionsSheet.swift, ledger CAN-192…196): a
// movable, modeless panel "canvas-export" (one id for both formats, so it reopens where it was
// left), with Scale (PNG), Background, Include grid and Include class legend under "Figure", the
// footer note, and Cancel / Export…. Every answer is remembered the moment it changes, as its
// @AppStorage did; Export… hands the answers to the Save panel step.
import { useId, useState } from "react";
import { Row, Section } from "../../workspace/files/Sheet";
import { PanelWindow } from "../../lib/panel";
import { closeExportPanel, confirmExport, useExportPanel, type ExportPanelState } from "./export";
import { loadExportOptions, PIXEL_SCALES, rememberExportOptions, type ExportBackground, type ExportFormat, type ExportOptions } from "./options";
import { PanelForm, Segmented } from "./PanelForm";
import { exportWords as w } from "./words";

/** DSSheetSize.compact: 560 × 400, resizable from 500 × 360. */
export const EXPORT_PANEL_SIZE: [number, number] = [560, 400];
export const EXPORT_PANEL_MIN: [number, number] = [500, 360];

export function footerNote(classCount: number): string {
  return classCount > 1 ? `${w.footerLight} ${w.footerClasses(classCount)}` : w.footerLight;
}

/** The PNG picker offers Canvas and White only; a remembered Transparent shows as neither. */
export function backgroundChoices(format: ExportFormat): readonly ExportBackground[] {
  return format === "pdf" ? ["canvas", "white", "transparent"] : ["canvas", "white"];
}

export function ExportOptionsForm({ format, classCount, onCancel, onConfirm }: { format: ExportFormat; classCount: number; onCancel: () => void; onConfirm: (o: ExportOptions) => unknown }) {
  const [options, setOptions] = useState<ExportOptions>(loadExportOptions);
  const uid = useId();
  const set = (patch: Partial<ExportOptions>) => {
    setOptions((o) => ({ ...o, ...patch }));
    void rememberExportOptions(patch);
  };
  return (
    <PanelForm
      id="canvas-export"
      title={format === "pdf" ? w.pdfTitle : w.pngTitle}
      subtitle={format === "pdf" ? w.pdfSubtitle : w.pngSubtitle}
      footer={{ cancelTitle: w.cancel, confirmTitle: w.confirm, canConfirm: true, cancelHelp: w.cancelHelp, confirmHelp: w.confirmHelp, onCancel, onConfirm: () => onConfirm(options) }}
    >
      <Section title={w.figure} footer={footerNote(classCount)}>
        {format === "png" && (
          <Row label={w.scale} help={w.scaleHelp}>
            <Segmented label={w.scale} help={w.scaleHelp} value={options.pixelScale} options={PIXEL_SCALES} title={w.scaleLabel} onChange={(s) => set({ pixelScale: s })} />
          </Row>
        )}
        <Row label={w.background} help={format === "pdf" ? w.backgroundHelpPdf : w.backgroundHelpPng}>
          <Segmented
            label={w.background}
            help={format === "pdf" ? w.backgroundHelpPdf : w.backgroundHelpPng}
            value={options.background}
            options={backgroundChoices(format)}
            title={(b) => w.backgrounds[b]}
            onChange={(b) => set({ background: b })}
          />
        </Row>
        <Row label={w.includeGrid} help={w.includeGridHelp} htmlFor={`${uid}-grid`}>
          <input id={`${uid}-grid`} type="checkbox" aria-label={w.includeGrid} checked={options.includesGrid} onChange={(e) => set({ includesGrid: e.target.checked })} />
        </Row>
        <Row label={w.includeLegend} help={classCount > 1 ? w.includeLegendHelp : w.includeLegendOneClass} htmlFor={`${uid}-legend`}>
          <input id={`${uid}-legend`} type="checkbox" aria-label={w.includeLegend} checked={options.includesLegend} disabled={classCount <= 1} onChange={(e) => set({ includesLegend: e.target.checked })} />
        </Row>
      </Section>
    </PanelForm>
  );
}

function ExportPanel({ state }: { state: ExportPanelState }) {
  return (
    <PanelWindow
      id="canvas-export"
      title={state.format === "pdf" ? w.pdfTitle : w.pngTitle}
      size={EXPORT_PANEL_SIZE}
      minSize={EXPORT_PANEL_MIN}
      modality="modeless"
      escapeCloses={false}
      onClose={closeExportPanel}
    >
      <ExportOptionsForm format={state.format} classCount={state.classCount} onCancel={closeExportPanel} onConfirm={(o) => confirmExport(state, o)} />
    </PanelWindow>
  );
}

/** Mount once (App.tsx): the options panel while an Export command is asking. */
export function ExportPanelHost() {
  const state = useExportPanel();
  return state ? <ExportPanel key={state.seq} state={state} /> : null;
}
