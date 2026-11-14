// The node inspector's sections: Identity, Capacity, the service or arrival law, Routing (0.90.34
// NodeInspectorSections.swift, ledger 4.2–4.6), parameterised by host so the Node Parameters panel
// and the docked pane render the SAME form over the same NodeDraft. The host owns the chrome and
// the commit policy; `onOpenLink` is what an outgoing Routing row does.
import { OverrideMark } from "../../scenarios/OverrideMark";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronRight, Ellipsis, Link as LinkGlyph } from "lucide-react";
import type { BnetLink, BnetNode } from "../../lib/bnet";
import { classLabel, KIND_NAMES, type Editor } from "../../editor";
import { isOperatorPicture, stationPicture, suggestedPicture } from "../../editor/pictures";
import { Icon } from "../../components/Icon";
import {
  card,
  changeDistribution,
  compactSummary,
  defaultDraft,
  displayMeanText,
  displayParam,
  displayScvText,
  draftErrors,
  familiesFor,
  fieldText,
  fixedSCV,
  formatSig,
  hasDiscreteSCV,
  hasFixedSCV,
  moments,
  parameterDefs,
  parseInteger,
  READOUT_DIGITS,
  setMeanText,
  setParam,
  setScvText,
  settledErrors,
  shortLabel,
  syncMode,
  ENTRY_MODE_NAMES,
  MEAN_KEY,
  SCV_KEY,
  type Distribution,
  type DistributionDraft,
  type EntryMode,
} from "./distributions";
import { ClassChip, ExitClassTag, GlossaryButton, InlineMessage, MenuPicker, NumericField, PicturePreview, Row, Segmented, TextField } from "./fields";
import { FAMILY_ICONS, KIND_ICONS } from "./icons";
import { BUFFER_RANGE, SERVERS_RANGE, type NodeParameterDraft as NodeDraft } from "./drafts";
import { PicturePickerPanel } from "./PicturePicker";
import { FitFromDataButton } from "../../fit/InspectorButton";
import { glossary as g, inspectorWords as w } from "./words";

export type InspectorHost = "pane" | "sheet";

const f5 = (v: number) => formatSig(v, READOUT_DIGITS);

/** Re-renders on every change of the draft. */
export function useDraft(model: { subscribe: (l: () => void) => () => void; version: number }): number {
  return useSyncExternalStore(model.subscribe, () => model.version);
}

export function Section({ title, header, footer, children, className }: { title: string; header?: ReactNode; footer?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`insp-section${className ? " " + className : ""}`} aria-label={title}>
      <header className="insp-section-header">
        <h3>{title}</h3>
        {header}
      </header>
      <div className="insp-section-body">{children}</div>
      {footer ? <p className="insp-section-footer">{footer}</p> : null}
    </section>
  );
}

export interface NodeSectionsProps {
  editor: Editor;
  model: NodeDraft;
  node: BnetNode;
  host: InspectorHost;
  nameRef?: (el: HTMLInputElement | null) => void;
  onOpenLink?: (linkID: string) => void;
  /** Return inside a field (the pane commits; the panel saves). */
  onSubmit?: () => void;
}

export function NodeSections(props: NodeSectionsProps) {
  const { model, node, host } = props;
  useDraft(model);
  const served = model.servedClasses;
  return (
    <>
      <IdentitySection {...props} />
      {node.kind === "buffer" ? <BufferCapacitySection {...props} /> : null}
      {node.kind === "station" ? (
        <>
          <StationCapacitySection {...props} />
          {!served.length ? (
            <SingleDistributionSection {...props} title={w.serviceTime} footer={w.serviceFooter} rateLabel="μ" />
          ) : host === "sheet" ? (
            <PerClassTableSection {...props} />
          ) : (
            <StackedClassSection {...props} />
          )}
          <RoutingSection {...props} />
        </>
      ) : null}
      {node.kind === "source" ? (
        <>
          <SingleDistributionSection {...props} title={w.interArrival} footer={w.sourceFooter(classLabel(props.editor.customerClassIndex(node.id)))} rateLabel="λ" />
          <RoutingSection {...props} />
        </>
      ) : null}
      {node.kind === "sink" ? (
        <>
          <Section title={w.behaviour}>
            <p className="insp-text">{w.sinkText}</p>
          </Section>
          <RoutingSection {...props} />
        </>
      ) : null}
    </>
  );
}

// ── Identity ─────────────────────────────────────────────────────────────────────────────────

function IdentitySection({ editor, model, node, host, nameRef, onSubmit }: NodeSectionsProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  // A picker left standing would write the previous node's draft (INS-026).
  useEffect(() => setPickerOpen(false), [node.id]);
  const servers = parseInteger(model.serversText);
  const pic = stationPicture(model.stationPicture);
  let suggestion = null;
  if (servers !== null && servers >= 1) {
    const s = suggestedPicture(servers);
    if (model.stationPicture === "" || (isOperatorPicture(model.stationPicture) && model.stationPicture !== s.sf)) suggestion = s;
  }
  const KindIcon = KIND_ICONS[node.kind];
  return (
    <Section title={w.identity}>
      <TextField
        label={w.name}
        value={model.nameText}
        placeholder={w.name}
        help={w.nameHelp}
        width={host === "pane" ? "fill" : "wide"}
        error={model.nameError(editor)}
        required
        inputRef={nameRef}
        onChange={(t) => model.update((m) => (m.nameText = t))}
        onFocusChange={(f) => model.update((m) => (m.nameIsFocused = f))}
        onSubmit={onSubmit}
      />
      <Row label={w.kind}>
        <span className="insp-kind">
          <Icon icon={KindIcon} size={12} />
          {KIND_NAMES[node.kind]}
        </span>
      </Row>
      {node.kind === "station" ? (
        <Row label={w.picture}>
          <span className="insp-picture-row" role="group" aria-label={w.pictureLabel(pic.displayName)}>
            <PicturePreview sf={model.stationPicture} size={26} />
            {host === "sheet" ? <span className="insp-picture-name">{pic.displayName}</span> : null}
            {suggestion ? (
              <button type="button" className="btn btn-small" title={w.usePictureHelp} onClick={() => model.update((m) => (m.stationPicture = suggestion.sf))}>
                {w.usePicture(suggestion.displayName)}
              </button>
            ) : null}
            <button type="button" className="btn btn-small" title={w.choosePictureHelp(pic.displayName)} onClick={() => setPickerOpen(true)}>
              {w.choosePicture}
            </button>
          </span>
          {pickerOpen ? (
            <PicturePickerPanel
              current={model.stationPicture}
              modality={host === "pane" ? "document" : "app"}
              onChoose={(sf: string) => model.update((m) => (m.stationPicture = sf))}
              onClose={() => setPickerOpen(false)}
            />
          ) : null}
        </Row>
      ) : null}
    </Section>
  );
}

// ── Capacity ─────────────────────────────────────────────────────────────────────────────────

function Readout({ label, value, unit, glossary, tint }: { label: string; value: number | null | undefined; unit: string | null; glossary: string; tint?: "danger" | "warning" | null }) {
  const has = value !== null && value !== undefined;
  return (
    <span className="insp-readout" title={glossary}>
      <span className="insp-readout-label">{label} =</span>
      <span className={`insp-readout-value${tint ? ` is-${tint}` : ""}${has ? "" : " is-unknown"}`}>{has ? f5(value) : "—"}</span>
      <span className="insp-readout-unit">{has ? (unit ?? "") : ""}</span>
    </span>
  );
}

function StationCapacitySection({ editor, model, node, host, onSubmit }: NodeSectionsProps) {
  const s = model.stability;
  const rho = s?.utilisation ?? null;
  let warning: string | null = null;
  if (s && rho !== null) {
    if (s.isUnstable) warning = w.unstable(f5(rho), node.name);
    else if (s.isHeavy) warning = w.heavy(f5(rho));
  }
  const tint = rho === null ? null : rho >= 1 ? "danger" : rho >= 0.95 ? "warning" : null;
  const a11y = s && rho !== null ? w.loadA11y(f5(s.arrivalRate), f5(s.capacity), f5(rho), s.isUnstable) : w.loadA11yNone;
  return (
    <Section title={w.capacity} footer={s ? w.capacityFooter : w.capacityFooterNone}>
      <NumericField
        label={w.servers}
        value={model.serversText}
        onChange={(t) => model.update((m) => (m.serversText = t))}
        range={SERVERS_RANGE}
        step={1}
        error={model.serversError}
        help={w.serversHelp}
        glossary={g.servers}
        placeholder="1"
        width="narrow"
        ariaLabel={w.serversA11y}
        integer
        onSubmit={onSubmit}
        dataField="servers"
      />
      <OverrideMark editor={editor} node={node.id} field="numberOfServers" />
      <Row label={w.load} glossary={g.rho} help={s ? w.loadHelp : w.loadHelpNone} warning={warning}>
        <span className={`insp-load${host === "pane" ? " is-stacked" : ""}`} role="group" aria-label={a11y} data-testid="load-readout">
          <Readout label="λ" value={s?.arrivalRate} unit={w.perTime} glossary={g.lambda} />
          <Readout label="c·μ" value={s?.capacity} unit={w.perTime} glossary={g.mu} />
          <Readout label="ρ" value={rho} unit={null} glossary={g.rho} tint={tint} />
        </span>
      </Row>
    </Section>
  );
}

function BufferCapacitySection({ editor, model, node, onSubmit }: NodeSectionsProps) {
  const inf = model.infiniteBuffersDraft;
  return (
    <Section title={w.capacity}>
      <Segmented label={w.networkBuffers} value={inf} options={[false, true] as const} render={(v) => (v ? w.infinite : w.finite)} onChange={(v) => model.update((m) => (m.infiniteBuffersDraft = v))} help={w.networkBuffersHelp} />
      <p className="insp-caption">{w.networkBuffersCaption}</p>
      <NumericField
        label={w.bufferSize}
        value={model.bufferSizeText}
        onChange={(t) => model.update((m) => (m.bufferSizeText = t))}
        unit={w.jobs}
        range={BUFFER_RANGE}
        step={1}
        error={inf ? null : model.bufferSizeError}
        help={inf ? w.bufferHelpInfinite : w.bufferHelp}
        glossary={g.bufferSize}
        placeholder="1"
        width="narrow"
        ariaLabel={w.bufferSize}
        disabled={inf}
        integer
        onSubmit={onSubmit}
        dataField="bufferSize"
      />
      <OverrideMark editor={editor} node={node.id} field="bufferSize" />
    </Section>
  );
}

// ── Distributions ────────────────────────────────────────────────────────────────────────────

function distributionOptions(kind: "station" | "source", subtitles: boolean, current: Distribution) {
  const list = familiesFor(kind);
  // A Poisson law stored per class at a station (INS-069) still shows as itself.
  if (!list.includes(current)) list.push(current);
  return list.map((d) => ({ value: d, label: subtitles ? `${card(d).pickerName}   ${card(d).menuSubtitle}` : card(d).displayName }));
}

function DistributionPicker({ value, kind, subtitles, onChange, bare, ariaLabel }: { value: Distribution; kind: "station" | "source"; subtitles: boolean; onChange: (d: Distribution) => void; bare?: boolean; ariaLabel?: string }) {
  return (
    <MenuPicker
      label={w.distribution}
      value={value}
      options={distributionOptions(kind, subtitles, value)}
      onChange={onChange}
      help={w.distributionHelp(kind === "source")}
      glossary={g.distribution}
      bare={bare}
      ariaLabel={ariaLabel}
      width={subtitles ? "wide" : "field"}
    />
  );
}

/** Native fields (one per parameter, a filler row for a one-parameter family) or Mean and SCV. */
function DistributionFields({ draft, mode, rateLabel, classPrefix, host, onDraft, onSubmit, onFocusField }: { draft: DistributionDraft; mode: EntryMode; rateLabel: "λ" | "μ"; classPrefix: string; host: InspectorHost; onDraft: (d: DistributionDraft) => void; onSubmit?: () => void; onFocusField?: () => void }) {
  const width = host === "pane" ? "narrow" : "field";
  const source = rateLabel === "λ";
  const focus = (f: boolean) => f && onFocusField?.();
  if (mode === "native") {
    const errors = draftErrors(draft, "native");
    const defs = parameterDefs(draft.distribution);
    return (
      <>
        {defs.map((p) => (
          <NumericField
            key={p.key}
            label={p.displayName}
            value={displayParam(draft, p.key)}
            onChange={(t) => onDraft(setParam(draft, p.key, t))}
            unit={p.unit}
            error={errors[p.key] ?? null}
            help={p.help}
            placeholder={fieldText(p.defaultValue)}
            width={width}
            ariaLabel={classPrefix + p.displayName}
            onSubmit={onSubmit}
            onFocusChange={focus}
            dataField={`param-${p.key}`}
          />
        ))}
        {defs.length < 2 ? <div className="insp-row insp-row-filler" aria-hidden="true" /> : null}
      </>
    );
  }
  const errors = draftErrors(draft, "moments");
  return (
    <>
      <NumericField
        label={w.mean}
        value={displayMeanText(draft)}
        onChange={(t) => onDraft(setMeanText(draft, t))}
        unit={w.time}
        error={errors[MEAN_KEY] ?? null}
        help={w.meanHelp(source)}
        glossary={g.mean}
        width={width}
        ariaLabel={classPrefix + w.meanA11y(source)}
        onSubmit={onSubmit}
        onFocusChange={focus}
        dataField="mean"
      />
      {hasFixedSCV(draft.distribution) ? (
        <Row label={w.scv} help={w.scvHelp} glossary={g.scv}>
          <span className="insp-text">{w.fixedByFamily(formatSig(fixedSCV(draft.distribution) ?? 0))}</span>
        </Row>
      ) : (
        <NumericField
          label={w.scv}
          value={displayScvText(draft)}
          onChange={(t) => onDraft(setScvText(draft, t))}
          unit={hasDiscreteSCV(draft.distribution) ? w.scvErlangUnit : null}
          error={errors[SCV_KEY] ?? null}
          help={hasDiscreteSCV(draft.distribution) ? w.scvErlangHelp : w.scvHelp}
          glossary={g.scv}
          width={width}
          ariaLabel={classPrefix + w.scvA11y}
          onSubmit={onSubmit}
          onFocusChange={focus}
          dataField="scv"
        />
      )}
    </>
  );
}

function statGlossary(label: string, family: string): string {
  if (label === "λ") return g.lambda;
  if (label === "μ") return g.mu;
  if (label === "mean") return g.mean;
  if (label === "SCV") return g.scv;
  return w.statGlossary(label, family);
}

function Stat({ label, value, unit, family }: { label: string; value: number | null | undefined; unit: string | null; family: string }) {
  const has = value !== null && value !== undefined;
  const text = has ? (Number.isFinite(value) ? f5(value) : "∞") : "—";
  return (
    <span className="insp-stat" aria-label={w.statA11y(label, has ? f5(value) : w.unknown)}>
      <span className="insp-stat-label" title={statGlossary(label, family)}>
        {label} =
      </span>
      <span className={`insp-stat-value${has && !Number.isFinite(value) ? " is-warning" : ""}${has ? "" : " is-unknown"}`}>{text}</span>
      {unit && has ? <span className="insp-stat-unit">{unit}</span> : null}
    </span>
  );
}

/** The card under a distribution: family, density, live mean / SCV / rate, the moment formulas (INS-051, INS-052). */
export function DistributionCard({ draft, mode, rateLabel, title, arrivalRate }: { draft: DistributionDraft; mode: EntryMode; rateLabel: "λ" | "μ"; title?: string; arrivalRate?: number | null }) {
  const m = moments(draft, mode);
  const c = card(draft.distribution);
  const FamilyIcon = FAMILY_ICONS[draft.distribution];
  return (
    <div className="insp-card" role="group" aria-label={title ?? c.pickerName}>
      <div className="insp-card-head">
        <Icon icon={FamilyIcon} size={14} />
        <span className="insp-card-title">{title ?? c.pickerName}</span>
        <span className="spacer" />
        {mode === "moments" ? <span className="insp-card-native">{w.native(compactSummary(draft))}</span> : null}
      </div>
      <div className="insp-card-formula">{c.formula}</div>
      <div className="insp-card-stats">
        <Stat label="mean" value={m.mean} unit={w.time} family={c.displayName} />
        <Stat label="SCV" value={m.scv} unit={null} family={c.displayName} />
        <Stat label={rateLabel} value={m.mean !== null && m.mean > 0 ? 1 / m.mean : null} unit={w.oneOverTime} family={c.displayName} />
        {arrivalRate !== undefined && arrivalRate !== null && rateLabel === "μ" ? <Stat label="λ" value={arrivalRate} unit={w.oneOverTime} family={c.displayName} /> : null}
      </div>
      <div className="insp-card-formula">{`${c.meanFormula}    ${c.scvFormula}`}</div>
    </div>
  );
}

function SingleDistributionSection({ editor, model, node, host, title, footer, rateLabel, onSubmit }: NodeSectionsProps & { title: string; footer: string; rateLabel: "λ" | "μ" }) {
  const d = model.draft;
  const kind = node.kind === "source" ? "source" : "station";
  return (
    <Section title={title} footer={footer}>
      <DistributionPicker value={d.distribution} kind={kind} subtitles={host === "sheet"} onChange={(v) => model.update((m) => (m.draft = changeDistribution(m.draft, v, m.entryMode)))} />
      <Segmented
        label={w.enterAs}
        value={model.entryMode}
        options={["native", "moments"] as const}
        render={(v) => ENTRY_MODE_NAMES[v]}
        onChange={(v) =>
          model.update((m) => {
            m.draft = syncMode(m.draft, v);
            m.entryMode = v;
          })
        }
        help={w.enterAsHelp}
        glossary={g.entryMode}
      />
      <DistributionFields draft={d} mode={model.entryMode} rateLabel={rateLabel} classPrefix="" host={host} onDraft={(nd) => model.update((m) => (m.draft = nd))} onSubmit={onSubmit} />
      <OverrideMark editor={editor} node={node.id} field="distribution" />
      <FitFromDataButton model={model} node={node} />
      <DistributionCard draft={d} mode={model.entryMode} rateLabel={rateLabel} />
    </Section>
  );
}

function EntryModePicker({ model }: { model: NodeDraft }) {
  return (
    <Segmented
      label={w.enterAs}
      value={model.classEntryMode}
      options={["native", "moments"] as const}
      render={(v) => ENTRY_MODE_NAMES[v]}
      onChange={(v) =>
        model.update((m) => {
          for (const [c, d] of m.classDrafts) m.classDrafts.set(c, syncMode(d, v));
          m.classEntryMode = v;
        })
      }
      help={w.enterAsClassHelp}
      glossary={g.entryMode}
    />
  );
}

function BulkMenu({ model, label, help, items }: { model: NodeDraft; label: string; help: string; items: { title: string; disabled?: boolean; run: () => void }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="insp-menu">
      <button type="button" className="btn btn-small insp-menu-btn" aria-haspopup="menu" aria-expanded={open} title={help} aria-label={label} onClick={() => setOpen((o) => !o)}>
        <Icon icon={Ellipsis} size={12} />
        {label === w.apply ? <span>{w.apply}</span> : null}
      </button>
      {open ? (
        <span role="menu" className="insp-menu-pop" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
          {items.map((it) => (
            <button
              key={it.title}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.run();
                model.changed();
              }}
            >
              {it.title}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

function ApplyMenu({ model }: { model: NodeDraft }) {
  const first = model.servedClasses[0];
  const items = [];
  if (first !== undefined) {
    const n = model.otherClassCount(first);
    items.push({ title: w.copyTo(classLabel(first), n), disabled: n === 0, run: () => model.copyToAllClasses(first) });
  }
  items.push({ title: w.expAll(model.servedClasses.length), run: () => model.applyToAllClasses(defaultDraft("exponential"), w.expName) });
  return <BulkMenu model={model} label={w.apply} help={w.applyHelp} items={items} />;
}

function classSectionFooter(model: NodeDraft, host: InspectorHost): string {
  if (host === "pane")
    for (const c of model.servedClasses) {
      const e = settledErrors(model.classDrafts.get(c)!, model.classEntryMode)[0];
      if (e) return `${classLabel(c)}: ${e}`;
    }
  return w.classFooter(model.servedClasses.length);
}

/** The pane's per-class editor: a class picker over one stacked set of fields (INS-066, INS-067). */
function StackedClassSection({ editor, model, node, host, onSubmit }: NodeSectionsProps) {
  const active = model.activeClassRow ?? model.servedClasses[0] ?? 0;
  const d = model.classDrafts.get(active) ?? defaultDraft("exponential");
  const set = (nd: DistributionDraft) => model.update((m) => m.classDrafts.set(active, nd));
  return (
    <Section title={w.perClassTitle} header={<ApplyMenu model={model} />} footer={classSectionFooter(model, host)}>
      <MenuPicker
        label={w.classPicker}
        value={active}
        options={model.servedClasses.map((c) => ({ value: c, label: classLabel(c) }))}
        onChange={(c) => model.update((m) => (m.activeClassRow = c))}
        help={w.classPickerHelp}
        glossary={g.customerClass}
      />
      <DistributionPicker value={d.distribution} kind="station" subtitles={false} onChange={(v) => set(changeDistribution(d, v, model.classEntryMode))} />
      <EntryModePicker model={model} />
      <DistributionFields draft={d} mode={model.classEntryMode} rateLabel="μ" classPrefix={`${classLabel(active)} `} host={host} onDraft={set} onSubmit={onSubmit} />
      <OverrideMark editor={editor} node={node.id} field="serviceDistributions" />
      <FitFromDataButton model={model} node={node} cls={active} />
      <DistributionCard draft={d} mode={model.classEntryMode} rateLabel="μ" title={w.cardTitle(classLabel(active), card(d.distribution).pickerName)} arrivalRate={model.stability?.arrivalRatePerClass.get(active)} />
    </Section>
  );
}

function NumberCell({ value, a11y }: { value: number | null | undefined; a11y: string }) {
  const has = value !== null && value !== undefined;
  return (
    <span className={`insp-cell insp-cell-num${has && !Number.isFinite(value) ? " is-warning" : ""}${has ? "" : " is-unknown"}`} aria-label={w.cellA11y(a11y, has ? f5(value) : w.unknown)}>
      {has ? (Number.isFinite(value) ? f5(value) : "∞") : "—"}
    </span>
  );
}

/** The panel's per-class table (INS-055…061). */
function PerClassTableSection({ model, node, onSubmit }: NodeSectionsProps) {
  const activeIdx = model.activeClassRow ?? model.servedClasses[0];
  const activeDraft = activeIdx !== undefined ? model.classDrafts.get(activeIdx) : undefined;
  const mode = model.classEntryMode;
  const setActive = (c: number) => model.activeClassRow !== c && model.update((m) => (m.activeClassRow = c));
  const moveRow = (from: number, offset: number, e: React.KeyboardEvent) => {
    if (model.fieldFocusCount > 0 || (e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "SELECT") return;
    const i = model.servedClasses.indexOf(from);
    const j = i + offset;
    if (j < 0 || j >= model.servedClasses.length) return;
    e.preventDefault();
    const next = model.servedClasses[j];
    setActive(next);
    // Each row sits in its own group: look in the whole table for the next one.
    const table = (e.currentTarget as HTMLElement).closest('[role="table"]') ?? e.currentTarget.parentElement?.parentElement;
    (table?.querySelector(`[data-class-row="${next}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <Section
      title={w.perClassTitle}
      header={
        <span className="insp-section-tools">
          <EntryModePicker model={model} />
          <ApplyMenu model={model} />
        </span>
      }
      footer={w.tableFooter}
    >
      <div className="insp-table" role="table" aria-label={w.tableA11y(model.servedClasses.length)}>
        <div className="insp-table-head" role="row">
          <span role="columnheader" title={w.colClass}>{w.colClass}</span>
          <span role="columnheader" title={w.colDistribution}>{w.colDistribution}</span>
          <span role="columnheader" className="is-flex" title={mode === "native" ? w.colParameters : w.colMoments}>{mode === "native" ? w.colParameters : w.colMoments}</span>
          <span role="columnheader" className="is-num" title={g.lambda} aria-label={`λ. ${g.lambda}`}>λ</span>
          <span role="columnheader" className="is-num" title={g.mean} aria-label={`${w.colMean}. ${g.mean}`}>{w.colMean}</span>
          <span role="columnheader" className="is-num" title={g.scv} aria-label={`${w.colSCV}. ${g.scv}`}>{w.colSCV}</span>
          <span role="columnheader" className="is-num" title={g.mu} aria-label={`μ. ${g.mu}`}>μ</span>
          <span aria-hidden="true" />
        </div>
        {model.servedClasses.map((c) => {
          const d = model.classDrafts.get(c) ?? defaultDraft("exponential");
          const errors = draftErrors(d, mode);
          const mm = moments(d, mode);
          const settled = settledErrors(d, mode);
          const rowMessage = settled.length ? settled.join("  ") : null;
          const isActive = activeIdx === c;
          const name = classLabel(c);
          const set = (nd: DistributionDraft) => model.update((m) => m.classDrafts.set(c, nd));
          const compact = (label: string, value: string, onChange: (t: string) => void, error: string | null, help: string, a11y: string, key: string) => (
            <span className="insp-compact" title={help} key={key}>
              <span className="insp-compact-label">{label}</span>
              <NumericField bare label={a11y} ariaLabel={a11y} value={value} onChange={onChange} error={error} help={help} width="compact" onSubmit={onSubmit} onFocusChange={(f) => f && setActive(c)} dataField={`class${c}-${key}`} />
            </span>
          );
          const others = model.otherClassCount(c);
          return (
            <div key={c} className="insp-table-group">
              <div
                role="row"
                className={`insp-table-row${isActive ? " is-active" : ""}`}
                aria-label={w.rowA11y(name)}
                aria-selected={isActive}
                tabIndex={-1}
                data-class-row={c}
                onFocus={() => setActive(c)}
                onMouseDown={() => setActive(c)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp") moveRow(c, -1, e);
                  else if (e.key === "ArrowDown") moveRow(c, 1, e);
                }}
              >
                <span className="insp-cell" role="cell">
                  <ClassChip index={c} />
                </span>
                <span className="insp-cell" role="cell">
                  <DistributionPicker
                    bare
                    ariaLabel={`${name} ${w.distribution}`}
                    value={d.distribution}
                    kind="station"
                    subtitles={false}
                    onChange={(v) =>
                      model.update((m) => {
                        m.classDrafts.set(c, changeDistribution(d, v, mode));
                        m.activeClassRow = c;
                      })
                    }
                  />
                </span>
                <span className="insp-cell is-flex" role="cell">
                  {mode === "native"
                    ? parameterDefs(d.distribution).map((p) => compact(shortLabel(p.displayName), displayParam(d, p.key), (t) => set(setParam(d, p.key, t)), errors[p.key] ?? null, p.help, `${name} ${p.displayName}`, p.key))
                    : [
                        compact(w.meanShort, displayMeanText(d), (t) => set(setMeanText(d, t)), errors[MEAN_KEY] ?? null, w.meanShortHelp, `${name} mean`, "mean"),
                        hasFixedSCV(d.distribution) ? (
                          <span key="scv" className="insp-text" title={w.scvFixedShortHelp(card(d.distribution).displayName)}>
                            {w.scvFixedShort(formatSig(fixedSCV(d.distribution) ?? 0))}
                          </span>
                        ) : (
                          compact(w.scvShort, displayScvText(d), (t) => set(setScvText(d, t)), errors[SCV_KEY] ?? null, w.scvShortHelp, `${name} SCV`, "scv")
                        ),
                      ]}
                </span>
                <NumberCell value={model.stability?.arrivalRatePerClass.get(c)} a11y={`${name} arrival rate λ`} />
                <NumberCell value={mm.mean} a11y={`${name} mean`} />
                <NumberCell value={mm.scv} a11y={`${name} SCV`} />
                <NumberCell value={mm.mean !== null && mm.mean > 0 ? 1 / mm.mean : null} a11y={`${name} service rate μ`} />
                <span className="insp-cell" role="cell">
                  <BulkMenu
                    model={model}
                    label={w.rowActions(name)}
                    help={w.rowActionsHelp(name)}
                    items={[
                      { title: w.copyTo(name, others), disabled: others === 0, run: () => model.copyToAllClasses(c) },
                      { title: w.resetRow(name), run: () => model.classDrafts.set(c, defaultDraft("exponential")) },
                    ]}
                  />
                </span>
              </div>
              <div className="insp-table-msg" title={rowMessage ?? ""} aria-label={rowMessage ? `${name}: ${rowMessage}` : undefined}>
                <InlineMessage message={rowMessage} lines={1} title={rowMessage ?? undefined} />
              </div>
            </div>
          );
        })}
      </div>
      {activeIdx !== undefined && activeDraft ? <FitFromDataButton model={model} node={node} cls={activeIdx} /> : null}
      {activeIdx !== undefined && activeDraft ? (
        <DistributionCard draft={activeDraft} mode={mode} rateLabel="μ" title={w.cardTitle(classLabel(activeIdx), card(activeDraft.distribution).pickerName)} arrivalRate={model.stability?.arrivalRatePerClass.get(activeIdx)} />
      ) : null}
    </Section>
  );
}

// ── Routing ──────────────────────────────────────────────────────────────────────────────────

function RoutingRow({ editor, link, other, outgoing, onOpen }: { editor: Editor; link: BnetLink; other: string; outgoing: boolean; onOpen?: () => void }) {
  const p = f5(link.routingProbability);
  const exit = link.toCustomerClass;
  const transition = exit !== undefined && exit !== link.customerClass;
  const spoken = w.routingRowA11y(classLabel(link.customerClass), outgoing ? `to ${other}` : `from ${other}`, p, transition ? classLabel(exit) : null);
  const body = (
    <>
      <ClassChip index={link.customerClass} compact />
      <Icon icon={LinkGlyph} size={12} />
      <span className="insp-route-name">{other}</span>
      {transition ? <ExitClassTag exitClass={exit} /> : null}
      <span className="spacer" />
      <span className="insp-route-p">{p}</span>
      <span className={onOpen ? "insp-chevron" : "insp-chevron is-hidden"} aria-hidden="true">
        <Icon icon={ChevronRight} size={12} />
      </span>
    </>
  );
  void editor;
  if (onOpen)
    return (
      <button type="button" className="insp-route-row" title={w.editLinkHelp(other)} aria-label={spoken} aria-description={w.routingRowHint} onClick={onOpen}>
        {body}
      </button>
    );
  return (
    <div className="insp-route-row is-incoming" title={w.incomingHelp(other)} aria-label={spoken} role="group">
      {body}
    </div>
  );
}

function RoutingSection({ editor, node, onOpenLink }: NodeSectionsProps) {
  const attached = editor.linksAttached(node.id);
  const outgoing = attached.filter((l) => l.fromNodeID === node.id);
  const incoming = attached.filter((l) => l.fromNodeID !== node.id);
  const classes = [...new Set(outgoing.map((l) => l.customerClass))].sort((a, b) => a - b);
  const totals = classes.map((c) => ({ cls: c, total: outgoing.filter((l) => l.customerClass === c).reduce((s, l) => s + l.routingProbability, 0) }));
  const unbalanced = totals.filter((t) => Math.abs(t.total - 1) > 1e-6);
  let message: string | null = null;
  if (unbalanced.length) {
    const u = unbalanced[0];
    message = u.total > 1 ? w.overOne(node.name, classLabel(u.cls), f5(u.total)) : w.underOne(node.name, classLabel(u.cls), f5(u.total), f5((1 - u.total) * 100));
  }
  return (
    <Section title={w.routing} header={<GlossaryButton label={w.routing} text={g.routingProbability} />} footer={outgoing.length ? w.routingFooter : w.routingFooterNone}>
      {!attached.length ? (
        <p className="insp-text">{w.noLinks}</p>
      ) : (
        <>
          <div className="insp-routes" role="group" aria-label={w.routingTableA11y(node.name, outgoing.length, incoming.length)}>
            {outgoing.length ? (
              <>
                <div className="insp-routes-head" role="heading" aria-level={4}>
                  {w.outgoing}
                </div>
                {outgoing.map((l) => (
                  <RoutingRow key={l.id} editor={editor} link={l} other={editor.node(l.toNodeID)?.name ?? "?"} outgoing onOpen={onOpenLink ? () => onOpenLink(l.id) : undefined} />
                ))}
                {totals.map((t) => (
                  <div key={t.cls} className="insp-route-total" aria-label={w.totalA11y(classLabel(t.cls), f5(t.total))}>
                    <ClassChip index={t.cls} compact />
                    <span>{w.total}</span>
                    <span className="spacer" />
                    <span className={`insp-route-p${Math.abs(t.total - 1) > 1e-6 ? " is-warning" : ""}`}>{f5(t.total)}</span>
                    <span className="insp-chevron is-hidden" aria-hidden="true">
                      <Icon icon={ChevronRight} size={12} />
                    </span>
                  </div>
                ))}
              </>
            ) : null}
            {incoming.length ? (
              <>
                <div className="insp-routes-head" role="heading" aria-level={4}>
                  {w.incoming}
                </div>
                {incoming.map((l) => (
                  <RoutingRow key={l.id} editor={editor} link={l} other={editor.node(l.fromNodeID)?.name ?? "?"} outgoing={false} />
                ))}
              </>
            ) : null}
          </div>
          <InlineMessage message={message} severity="warning" />
        </>
      )}
    </Section>
  );
}
