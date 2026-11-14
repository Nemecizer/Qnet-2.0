// Network ▸ Network Model… (0.90.34 NetworkModelGuideView.swift; ledger ANA-226…236, SET-202): a
// non-spatial outline of the network — its nodes in document order and its routes, each a button
// that selects it on the canvas — and the network-wide capacity model with the finite-buffer
// blocking rules compared.
//
// One window, "network-model", built once and re-pointed at the active tab on each open, as the
// Method Chooser is. It follows that tab's document and selection; the page picker starts on the
// outline every time the window is built and is not saved. The buffer model is changed through the
// editor (`setInfiniteBuffers`, undoable on the canvas); the blocking rule is the `sim.blocking`
// setting.
import { useState, useSyncExternalStore } from "react";
import { Check, Info, Link2, Network as NetworkIcon } from "lucide-react";
import { Icon } from "../../components/Icon";
import { raiseAuxWindow } from "../../lib/auxWindow";
import { setSettings, useSetting } from "../../lib/kv";
import type { BnetDocument, BnetLink, BnetNode } from "../../lib/bnet";
import { classLabel, editorFor, KIND_NAMES, useEditorView } from "../../editor";
import { KIND_ICONS } from "../../canvas/layers/icons";
import { readout } from "../../panes/status/FlagBar";
import { asDistribution, card } from "../../panes/inspector/distributions/families";
import { activeTab, getWorkspace, useWorkspace } from "../../workspace/store";
import { AnalysisWindow, Badge, EmptyState } from "../../analysis/AnalysisWindow";
import { networkModelWords as w } from "./words";

export const NETWORK_MODEL_WINDOW = "network-model";
export const NETWORK_MODEL_FRAME_KEY = "WindowFrame.QnetNetworkModelWindow";

let model: { tabId: string } | null = null;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach((l) => l());

/** Network ▸ Network Model…: opens the window for the active tab, or re-points the open one and brings it forward. */
export function openNetworkModel(tabId: string = activeTab(getWorkspace()).id) {
  const wasOpen = model !== null;
  model = { tabId };
  publish();
  if (wasOpen) raiseAuxWindow(NETWORK_MODEL_WINDOW);
}

export function closeNetworkModel() {
  model = null;
  publish();
}

export function networkModelState() {
  return model;
}

/** `nodeDescription`. */
export function nodeDescription(node: BnetNode, infiniteBuffers: boolean): string {
  switch (node.kind) {
    case "station":
      return w.station(node.numberOfServers, Math.max(Object.keys(node.serviceDistributions ?? {}).length, 1));
    case "buffer":
      return infiniteBuffers ? w.bufferInfinite(node.bufferSize) : w.bufferFinite(node.bufferSize);
    case "source":
      return w.source(card(asDistribution(node.distribution)).pickerName, node.distributionParameters);
    case "sink":
      return w.sink;
  }
}

/** `classDescription`: the class, or "Class a → Class b" for a link that changes it. */
export function classDescription(link: BnetLink): string {
  const incoming = classLabel(link.customerClass);
  const exit = link.toCustomerClass ?? link.customerClass;
  return exit === link.customerClass ? incoming : w.transition(incoming, classLabel(exit));
}

function Outline({ tabId, doc }: { tabId: string; doc: BnetDocument }) {
  const editor = editorFor(tabId);
  const view = useEditorView(editor);
  if (!doc.nodes.length) {
    return <EmptyState icon={<Icon icon={NetworkIcon} size={20} />} title={w.emptyTitle} message={w.emptyMessage} />;
  }
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const selectNode = (id: string) => editor.setView({ selectedLinkID: null, selectedNodeIDs: new Set(), selectedNodeID: id });
  const selectLink = (id: string) => editor.setView({ selectedNodeID: null, selectedNodeIDs: new Set(), selectedLinkID: id });
  return (
    <div className="nm-outline">
      <section className="nm-nodes" aria-label={w.nodesLabel}>
        <h3 className="an-section-caption">{w.nodesSection}</h3>
        <ul>
          {doc.nodes.map((n) => {
            const selected = view.selectedNodeID === n.id || view.selectedNodeIDs.has(n.id);
            return (
              <li key={n.id}>
                <button type="button" className="nm-item" title={w.nodeHint} aria-description={w.nodeHint} onClick={() => selectNode(n.id)}>
                  <span className="nm-kind" data-kind={n.kind}>
                    <Icon icon={KIND_ICONS[n.kind]} size={14} />
                  </span>
                  <span className="nm-text">
                    <span>
                      <strong>{n.name}</strong> <span className="an-caption">{KIND_NAMES[n.kind]}</span>
                    </span>
                    <span className="an-caption">{nodeDescription(n, doc.infiniteBuffers)}</span>
                  </span>
                  {selected ? <Icon icon={Check} size={14} className="nm-check" aria-label={w.selected} /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      <section className="nm-routes" aria-label={w.routesLabel}>
        <div className="nm-routes-head">
          <h3>{w.routes}</h3>
          <Badge text={String(doc.links.length)} />
        </div>
        {!doc.links.length ? (
          <EmptyState icon={<Icon icon={Link2} size={20} />} title={w.noRoutesTitle} message={w.noRoutesMessage} />
        ) : (
          <ul>
            {doc.links.map((l) => (
              <li key={l.id}>
                <button type="button" className="nm-item" title={w.routeHint} aria-description={w.routeHint} onClick={() => selectLink(l.id)}>
                  <span className="nm-kind">
                    <Icon icon={Link2} size={14} />
                  </span>
                  <span className="nm-text">
                    <strong>{w.route(byId.get(l.fromNodeID)?.name ?? w.missingNode, byId.get(l.toNodeID)?.name ?? w.missingNode)}</strong>
                    <span className="an-caption mono">
                      {classDescription(l)}&nbsp;&nbsp;{w.probability(readout(l.routingProbability))}
                    </span>
                  </span>
                  {view.selectedLinkID === l.id ? <Icon icon={Check} size={14} className="nm-check" aria-label={w.selected} /> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Capacity({ tabId, doc }: { tabId: string; doc: BnetDocument }) {
  const blocking = Number(useSetting<number>("sim.blocking", 2));
  const infinite = doc.infiniteBuffers;
  const current = w.rules[blocking]?.name ?? w.unknown;
  return (
    <div className="nm-capacity">
      <section>
        <h3>{w.capacityTitle}</h3>
        <div role="radiogroup" aria-label={w.bufferModel} className="nm-radios">
          {[false, true].map((v) => (
            <label key={String(v)}>
              <input type="radio" name="nm-buffer-model" checked={infinite === v} onChange={() => editorFor(tabId).setInfiniteBuffers(v)} />
              {v ? w.infinite : w.finite}
            </label>
          ))}
        </div>
        <p className="an-callout">{infinite ? w.infiniteExplanation : w.finiteExplanation}</p>
      </section>
      <hr className="an-rule" />
      <section>
        <div className="nm-blocking-head">
          <h3>{w.blockingTitle}</h3>
          <span className="spacer" />
          <Badge text={current} tint="info" />
        </div>
        <div className="an-segmented" role="radiogroup" aria-label={w.pickerLabel} aria-disabled={infinite || undefined}>
          {w.rules.map((r, i) => (
            <button key={r.name} type="button" role="radio" aria-checked={blocking === i} data-on={blocking === i || undefined} disabled={infinite} onClick={() => void setSettings({ "sim.blocking": i })}>
              {r.name}
            </button>
          ))}
        </div>
        <table className="nm-table" aria-label={w.tableLabel}>
          <thead>
            <tr>
              {w.headers.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {w.rules.map((r) => (
              <tr key={r.name}>
                <th scope="row">{r.name}</th>
                <td>{r.fullDestination}</td>
                <td>{r.upstream}</td>
                <td>{r.interpretation}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="nm-note">
          <Icon icon={Info} size={14} />
          <span>{w.srbmNote}</span>
        </p>
      </section>
    </div>
  );
}

export function NetworkModelView({ tabId, onClose }: { tabId: string; onClose: () => void }) {
  const tab = useWorkspace((ws) => ws.tabs.find((t) => t.id === tabId));
  const [page, setPage] = useState<"outline" | "capacity">("outline");
  if (!tab) {
    return (
      <div className="an-fill">
        <EmptyState icon={<Icon icon={NetworkIcon} size={20} />} title={w.noNetworkTitle} message={w.noNetworkMessage} />
      </div>
    );
  }
  return (
    <div className="an-fill" aria-label={w.windowTitle}>
      <header className="an-header">
        <Icon icon={NetworkIcon} size={20} className="an-glyph" />
        <div className="an-heading">
          <h2>{w.title}</h2>
          <span className="an-caption">{w.subtitle}</span>
        </div>
        <span className="spacer" />
        <div className="an-segmented" role="radiogroup" aria-label={w.pageLabel}>
          {(["outline", "capacity"] as const).map((p) => (
            <button key={p} type="button" role="radio" aria-checked={page === p} data-on={page === p || undefined} onClick={() => setPage(p)}>
              {w.pages[p]}
            </button>
          ))}
        </div>
      </header>
      <div className="nm-page">{page === "outline" ? <Outline tabId={tabId} doc={tab.document} /> : <Capacity tabId={tabId} doc={tab.document} />}</div>
      <footer className="an-footer">
        <span className="an-caption">{w.footer}</span>
        <span className="spacer" />
        <button type="button" className="btn primary" onClick={onClose}>
          {w.close}
        </button>
      </footer>
    </div>
  );
}

/** Mounts the Network Model window while it is open. */
export function NetworkModelHost() {
  const m = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => model,
  );
  if (!m) return null;
  return (
    <AnalysisWindow name={NETWORK_MODEL_WINDOW} title={w.windowTitle} frameKey={NETWORK_MODEL_FRAME_KEY} onClose={closeNetworkModel} onDefault={closeNetworkModel}>
      <NetworkModelView tabId={m.tabId} onClose={closeNetworkModel} />
    </AnalysisWindow>
  );
}

/** For tests. */
export function resetNetworkModel() {
  model = null;
  publish();
}
