// The files area's three sheets: Generate Random Network (GEN-001…011), Export SRBM Solver Input
// (EXP-111…113) and Export All's blocking convention (EXP-114). One is up at a time, as SwiftUI
// showed one sheet per scene; `openSheet` is what the commands call.
import { useId, useState, useSyncExternalStore } from "react";
import { CountField } from "../../components/CountField";
import { useActiveTab } from "../store";
import { exportAllTo, exportSrbm } from "./exports";
import { generateRandomNetwork, parseSeed, RANDOM_DEFAULTS, randomProblem, type RandomForm, type Topology } from "./generate";
import { stem } from "./paths";
import { Glossary, Row, Section, Sheet } from "./Sheet";
import { BLOCKING_CONVENTIONS, fileWords as w, type BlockingConventionId } from "./words";

export type SheetKind = "random" | "srbm" | "export-all";

let current: SheetKind | null = null;
const listeners = new Set<() => void>();

export function openSheet(kind: SheetKind) {
  if (current) return;
  current = kind;
  listeners.forEach((l) => l());
}

export function closeSheet() {
  current = null;
  listeners.forEach((l) => l());
}

export function currentSheet(): SheetKind | null {
  return current;
}

function useSheet(): SheetKind | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

export function Sheets() {
  const kind = useSheet();
  if (kind === "random") return <GenerateRandomSheet />;
  if (kind === "srbm") return <SrbmExportSheet />;
  if (kind === "export-all") return <ExportAllSheet />;
  return null;
}


export function GenerateRandomSheet() {
  const [form, setForm] = useState<RandomForm>(RANDOM_DEFAULTS);
  const uid = useId();
  const set = (patch: Partial<RandomForm>) => setForm((f) => ({ ...f, ...patch }));
  const problem = randomProblem(form);
  const seedBad = parseSeed(form.seed) === null;
  return (
    <Sheet
      id="generate-random"
      title={w.randomTitle}
      subtitle={w.randomSubheading}
      footer={{
        problem,
        confirmTitle: w.generate,
        canConfirm: problem === null,
        cancelHelp: w.randomCancelHelp,
        confirmHelp: w.randomConfirmHelp,
        blockedHelp: w.randomBlockedHelp,
        onCancel: closeSheet,
        onConfirm: async () => {
          if (await generateRandomNetwork(form)) closeSheet();
        },
      }}
    >
      <Section title={w.structureSection}>
        <Row label={w.stationsLabel} help={w.stationsHelp} htmlFor={`${uid}-d`}>
          <CountField id={`${uid}-d`} label={w.stationsField} value={form.stations} min={1} max={20} decrementLabel={w.decrement(w.stationsField)} incrementLabel={w.increment(w.stationsField)} onChange={(stations) => set({ stations })} />
        </Row>
        <Row label={w.classesLabel} help={w.classesHelp} htmlFor={`${uid}-c`}>
          <CountField id={`${uid}-c`} label={w.classesField} value={form.classes} min={1} max={8} decrementLabel={w.decrement(w.classesField)} incrementLabel={w.increment(w.classesField)} onChange={(classes) => set({ classes })} />
        </Row>
        <Row label={w.buffersLabel} help={w.buffersHelp} htmlFor={`${uid}-b`}>
          <select id={`${uid}-b`} className="qn-field" value={form.infiniteBuffers ? "infinite" : "finite"} onChange={(e) => set({ infiniteBuffers: e.target.value === "infinite" })}>
            <option value="infinite">{w.infinite}</option>
            <option value="finite">{w.finite}</option>
          </select>
        </Row>
        <Row label={w.topologyLabel} help={w.topologyHelp} htmlFor={`${uid}-t`}>
          <select id={`${uid}-t`} className="qn-field" value={form.topology} onChange={(e) => set({ topology: e.target.value as Topology })}>
            {(Object.keys(w.topologies) as Topology[]).map((t) => (
              <option key={t} value={t}>{w.topologies[t]}</option>
            ))}
          </select>
        </Row>
      </Section>
      <Section title={w.loadSection} footer={w.loadFooter}>
        <Row label={w.rhoLabel} help={w.rhoHelp} htmlFor={`${uid}-r`}>
          <input id={`${uid}-r`} className="qn-field qn-field-compact" type="text" inputMode="decimal" aria-label={w.rhoField} placeholder="0.90" value={form.rho} onChange={(e) => set({ rho: e.target.value })} />
          <Glossary label={w.rhoField} text={w.rhoGlossary} />
        </Row>
        <Row label={w.seedLabel} help={w.seedHelp} htmlFor={`${uid}-s`}>
          <span className="qn-field-stack">
            <input
              id={`${uid}-s`}
              className="qn-field"
              type="text"
              inputMode="numeric"
              aria-label={w.seedField}
              aria-invalid={seedBad || undefined}
              placeholder={w.seedPlaceholder}
              value={form.seed}
              onChange={(e) => set({ seed: e.target.value })}
            />
            {seedBad && <span className="qn-field-error">{w.seedFieldError}</span>}
          </span>
        </Row>
      </Section>
    </Sheet>
  );
}

function ConventionPicker({ id, value, disabled, help, onChange }: { id: string; value: BlockingConventionId; disabled?: boolean; help: string; onChange: (v: BlockingConventionId) => void }) {
  return (
    <select id={id} className="qn-field" aria-label={w.blockingPicker} title={help} disabled={disabled} value={value} onChange={(e) => onChange(e.target.value as BlockingConventionId)}>
      {BLOCKING_CONVENTIONS.map((c) => (
        <option key={c.id} value={c.id}>{c.title}</option>
      ))}
    </select>
  );
}

export function SrbmExportSheet() {
  const tab = useActiveTab();
  const doc = tab.document;
  const [convention, setConvention] = useState<BlockingConventionId>("manufacturing");
  const uid = useId();
  const empty = doc.nodes.length === 0;
  const stations = doc.nodes.filter((n) => n.kind === "station").length;
  const classes = new Set(doc.links.map((l) => l.customerClass)).size;
  const detail = BLOCKING_CONVENTIONS.find((c) => c.id === convention)!.detail;
  return (
    <Sheet
      id="srbm-export"
      title={w.srbmTitle}
      subtitle={w.srbmSubheading}
      glossary={{ label: w.covarianceLabel, text: w.covarianceGlossary }}
      footer={{
        problem: empty ? w.srbmEmpty : null,
        helpTopic: "solverInputs",
        confirmTitle: w.srbmConfirm,
        canConfirm: !empty,
        cancelHelp: w.srbmCancelHelp,
        confirmHelp: w.srbmConfirmHelp,
        blockedHelp: w.srbmBlockedHelp,
        onCancel: closeSheet,
        onConfirm: async () => {
          if (await exportSrbm(tab, convention)) closeSheet();
        },
      }}
    >
      <Section title={w.documentSection}>
        <Row label={w.networkRow}><span className="qn-truncate">{tab.path ? stem(tab.path) : w.untitled}</span></Row>
        <Row label={w.stationsRow}><span className="qn-number">{stations}</span></Row>
        <Row label={w.classesRow}><span className="qn-number">{classes}</span></Row>
        <Row label={w.buffersRow}>{doc.infiniteBuffers ? w.buffersInfinite : w.buffersFinite}</Row>
      </Section>
      <Section title={w.blockingSection} footer={doc.infiniteBuffers ? w.blockingInfiniteFooter : detail}>
        <Row label={w.blockingPicker} htmlFor={`${uid}-bc`}>
          <ConventionPicker id={`${uid}-bc`} value={convention} disabled={doc.infiniteBuffers} help={doc.infiniteBuffers ? w.blockingHelpInfinite : w.blockingHelpFinite} onChange={setConvention} />
        </Row>
      </Section>
    </Sheet>
  );
}

export function ExportAllSheet() {
  const tab = useActiveTab();
  const [convention, setConvention] = useState<BlockingConventionId>("manufacturing");
  const uid = useId();
  return (
    <Sheet
      id="export-all"
      title={w.exportAllTitle}
      subtitle={w.exportAllSubheading}
      footer={{
        helpTopic: "solverInputs",
        confirmTitle: w.exportAllConfirm,
        canConfirm: true,
        cancelHelp: w.exportAllCancelHelp,
        confirmHelp: w.exportAllConfirmHelp,
        blockedHelp: w.exportAllConfirmHelp,
        onCancel: closeSheet,
        onConfirm: () => {
          // The sheet closes before the folder panel opens, as the run-parameter sheet did.
          closeSheet();
          return exportAllTo(tab, convention);
        },
      }}
    >
      <Section title={w.exportAllSection} footer={w.exportAllFooter}>
        <Row label={w.blockingPicker} htmlFor={`${uid}-bc`}>
          <ConventionPicker id={`${uid}-bc`} value={convention} help={w.exportAllFieldHelp} onChange={setConvention} />
          <Glossary label={w.basGlossaryLabel} text={w.basGlossary} />
        </Row>
      </Section>
    </Sheet>
  );
}
