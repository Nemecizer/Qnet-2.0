# Edit scenarios

What Qnet 0.90.34's editor does with scripted edit sequences, so the TypeScript editor model (P5) can replay the same scenarios and be compared after every step: "a network can be built, edited, undone, saved and reopened with the result byte-identical to the same steps in 0.90.34". Made by `scripts/make-golden-canvas.sh` with `Qnet --golden-edits <scenario.json> <out-dir> <examples-dir>` (`../tools/GoldenCanvas.swift`); never edit a file here by hand. `PROVENANCE.json` names the commit, the toolchain, the copy's changes and a SHA-256 for every file.

The inputs are `../tools/edit-scenarios/<scenario>.json`; the outputs are `<scenario>/`:

| File | What it is |
|---|---|
| `step-00.json`, `step-00.bnet` | the starting state: an empty editor, or the example opened |
| `step-NN.json` | the model's observable state after step NN (below) |
| `step-NN.bnet` | the document after step NN, saved exactly as File ▸ Save writes it (`TabDocumentWriter.write`: `JSONEncoder`, pretty-printed, sorted keys; `canvasScale` is saved, `canvasPanOffset` is not) |
| `reopened.bnet` | the last step's file opened in a fresh model (`loadNetwork`) and saved again; in every scenario it is byte-identical to the last `step-NN.bnet` |

## Comparing

0.90.34 gives every node and link it creates a fresh random UUID, so a `.bnet` is compared after numbering the UUIDs in order of first appearance within the file (as `core/tests/golden_generators.rs` does for the generator corpus); everything else, field order and whitespace included, must match byte for byte. Ids that came from the example file are the file's own and do not change. The `.json` files hold no UUIDs: nodes are named by `{"index", "name"}` and links by `{"index", "from", "to", "customerClass"}` (indices into the current `nodes` / `links`), and they reproduce byte for byte. Doubles are printed with `%.17g` (parse and compare as numbers). Replaying every scenario twice gives the same files, ids aside (checked).

## How a step runs

**One step is one AppKit event.** `NetworkEditorModel.undoManager` is a plain `UndoManager()`, so `groupsByEvent` is true, as in the app: the first registration in an event opens an undo group, every registration made before the event ends lands in it, and the group closes when the main run loop finishes the event. The replay runs each step, then turns the main run loop (a 1 ms timer keeps it from returning at once for want of a source) until `undoManager.groupingLevel` is 0, and only then records the state and starts the next step. That is why two registrations in one step merge into one undo entry, as they do in the app: in `nudge-runs` step 29 an `addNode` made while an arrow-key run was still open commits the run's "Move Node" and its own "Add Sink" in the same event, and one Undo (step 30) reverses both. Setting `groupsByEvent = false` and wrapping each step in `beginUndoGrouping()`/`endUndoGrouping()` would give the same groups; turning the run loop was chosen because it is the app's own mechanism and needs no change to the model.

**Time.** Two runs coalesce by the clock: an arrow-key nudge run ends after 1.2 s without a press (`nudgeRunTimeout`), and a docked-inspector field run after 2.0 s without a commit (`parameterRunTimeout`). Consecutive steps follow each other at once (the replay fails if two steps are more than 0.5 s apart, and writes outside Dropbox so a slow disk cannot stall it), so consecutive presses or commits DO continue a run. A run ends only through what the scenario says: `arrowKeyUp` (or anything else that calls `endNudgeRun`: a selection change through `setNodeSelection`, any `performMutation`/`beginMutation`), `endParameterRun` (or a selection change in the pane, an undo, a commit to another field), or `{"op": "wait", "seconds": s}`, which really waits s seconds with the run loop turning.

**The docked Inspector is shown** (`AppSettings.Defaults.inspectorPaneVisible` is true) unless the scenario says `"inspectorPane": false`. After every step the replay does what `InspectorPaneView` does when the selection or the document changes: `syncSelection` (commit a dirty draft of the previous target with `coalescing: true`, logging "Discarded invalid edit to …" when it cannot, then `endParameterRun()`; `applyParameterCacheOverlay` and `load` the new target) and `reloadIfIdle` (`refresh` a clean node draft; `load` a link draft only while `isDirty(editor:)` is false). The pane's draft objects persist across steps, as the pane does.

**The camera.** The viewport is 1200 × 800 unless the scenario gives `"viewport": [w, h]`; it is `canvasViewportSize` (Zoom to Fit, Zoom to Selection, Straighten and Fit to Window, the zoom-in/out anchor) and the clip view's bounds for Tab's reveal-if-off-screen pan. Points given to canvas gestures (`at`, `from`, `to`) are DISPLAY points, mapped through the current `canvasTransform`; at zoom 1 with no pan they equal world points. A `by` given to a drag is a display translation (the drag divides it by the scale); a `by` given to a model method is in world points.

## Scenario files

```json
{
 "description": "…",
 "start": "Tandem2.MM1.K5.fin",      // an example stem (examples/<stem>.bnet), or null for an empty canvas
 "viewport": [1200, 800],             // optional
 "inspectorPane": true,               // optional
 "steps": [ {"op": "…", …}, … ]
}
```

**Step 0** is `{"op": "open", "file": …}` (QnetGUIApp.loadNetworkFile into the blank first tab: decode, `loadNetwork(document:)`, `currentFileURL = url`, `addStatus("Loaded <file>.", severity: .success)`) or `{"op": "empty"}`. Its status lines include the editor's initial "Ready. …" line. The app then runs Show Network Primitives, which writes to the Shell and the flag bar; that is not replayed (it is `golden/<example>/primitives.txt`).

**References.** A node is a name (the first node in document order with that name), an index into `nodes`, or `{"name": …}` / `{"index": …}`. A link is an index into `links`, `{"index": …}`, or `{"from": node, "to": node, "class": c}` (the first link in document order between those nodes, with entry class `c` if given). A reference is resolved when its step runs, against the document as it is then.

## Step vocabulary

Every op calls the 0.90.34 method named, with the arguments given. Booleans default to false. "Replica" marks a gesture whose logic lives in a private SwiftUI/AppKit view (`CanvasContentView`, `CanvasClipView`, `InspectorPaneView`, the class legend): the replay repeats that view code's model calls, in its order, and the TypeScript editor must implement the same sequence.

### Tools and clicks

| Op | Arguments | 0.90.34 |
|---|---|---|
| `setTool` | `tool`: an `EditorTool` raw value (`select`, `multiSelect`, `pan`, `addStation`, `addBuffer`, `addSource`, `addSink`, `addLink`) | `setTool(_:)` (also what the letter keys and the palette call) |
| `canvasClick` | `at`, `extending` (⇧/⌘ held) | Replica of `canvasDrag.onEnded` on empty canvas, outside the double-click window. Fails unless `at` hits no node and no link (`CanvasScene.hitNode` / `hitLink`). Sets `lastMouseDownExtendsSelection`. Pan tool: as `panDrag` by (0, 0). Multi-Select: `beginMultiSelect` + `updateMultiSelect` at the point, then the zero-area band is dropped (`multiSelectRect = nil`, `multiSelectOrigin = nil`). Then, if `extending` in Pointer/Multi-Select, nothing; else `handleCanvasTap(at: snapIfNeeded(CanvasMath.clampWorld(canvasTransform.toLogical(at))))` |
| `canvasDoubleClick` | `at` | `canvasClick` at `at`, then the second click: Pointer / Multi-Select → `enterStickyPan()`; an add tool → nothing (the second node would land on the same point; a note says so); Link tool → `handleCanvasTap` again |
| `nodeClick` | `node`, `extending` | `handleNodeTap(nodeID:extendingSelection:)` (sets `lastMouseDownExtendsSelection`) |
| `nodeDoubleClick` | `node` | `handleNodeTap(nodeID:)`, then in Pointer/Multi-Select `openParameterEditor(for:)`, in other tools `handleNodeTap` again |
| `linkClick` | `link` | `handleLinkTap(linkID:)` (Pointer only; a click on a selected link is `cycleLinkCustomerClass`) |
| `linkDoubleClick` | `link` | `handleLinkTap(linkID:)`, then `openLinkParameterEditor(for:)` |
| `legendClick` | `class` | Replica of the class legend button: `classFilter = (classFilter == class) ? nil : class` |
| `setSnapToGrid` | `value` | `snapToGrid = value` (View ▸ Snap to Grid, the zoom cluster's toggle) |

### Drags (replicas of `CanvasContentView`)

| Op | Arguments | 0.90.34 |
|---|---|---|
| `dragNode` | `node`, `by`, `extending` (⇧/⌘ at mouse-down), `option` (⌥ at mouse-down), `control` (⌃ held), `escape` (Escape before release) | `nodeDrag` in Pointer/Multi-Select, one frame at translation `by`, then release. Translation ≤ 2 (`dragThreshold`): it is a click, `handleNodeTap(nodeID:extendingSelection:)`. Else: if the node is not in `selectionUnion` it becomes the selection (`setNodeSelection([node])`, or the group plus it when `extending`) and `selectedLinkID = nil`; `beginMutation("Move Node" / "Move Nodes" / "Duplicate and Move Node(s)")` by group size; with `option`, `duplicateSelectionInPlaceForDrag()` and the copies become the dragged group; start positions recorded; `isDraggingNode = true`; `moveAnchoredNodes` (below); release: `endMutation()`, `isDraggingNode = false`, `snapSuspended = false`, guides cleared. With `escape` and no duplicate: every node back to its start (`moveNode(snap: false)`) BEFORE `endMutation()`, so nothing is registered. With `escape` after an ⌥-duplicate: the drag is not cancellable, Escape reaches the canvas as `deselectAll()`, and the release then commits the drag. The step's JSON carries the frame's `alignGuides` |
| `dragConnect` | `from`, `to` (a node, or `null` for empty canvas), `returned` (the pointer left `from` and came back) | Link-tool `nodeDrag.onEnded`: `to` null → nothing; `to == from` without `returned` → `handleNodeTap(nodeID: from)` (a click); else `completeLinkDrag`: if `pendingLinkStartID != from` { `pendingLinkStartID = nil`; `handleNodeTap(from)`; stop unless `pendingLinkStartID == from` }; `handleNodeTap(to)` |
| `dragLink` | `link`, `by`, `escape` | `canvasDrag` from a link, Pointer tool. Translation ≤ 3 (`linkDragThreshold`): `handleLinkTap`. Else select the link if it is not (`selectedLinkID = id; selectedNodeID = nil; selectedNodeIDs = []`), `beginMutation("Move Link")`, `isDraggingNode = true`, `moveAnchoredNodes` over both ends, release as for `dragNode` (`escape` restores both ends first) |
| `marquee` | `from`, `to`, `extending` | `canvasDrag` from empty canvas (`from` must hit nothing). Multi-Select, or Pointer with a drag longer than 5 (`marqueeThreshold`): `beginMultiSelect(at: toLogical(from))` (if no origin), `updateMultiSelect(to: toLogical(to))`, then on release `finalizeMultiSelect(extending:)` if the band has width or height; a zero-area band is dropped and the release is a click at `to` (as `canvasClick`). The step's JSON carries `marqueeNodeCount` (the live count before the release) |
| `panDrag` | `by` | `panChanged` / `panEnded` (Pan tool): `canvasPanOffset = start + by`; `isPanningCanvas` on and off; a translation ≤ 2 is a click, `exitStickyPan()` |

`moveAnchoredNodes(by:scale:)`, replayed exactly: `delta = by / scale`; `snapSuspended = control`; unless `control`, with the anchor = the node under the pointer (for `dragLink`: an end, see below) and its start position: candidate = its body rect at start + delta; `SmartGuides.match(anchor: candidate, others: world rects of every node not being dragged, tolerance: 4 / max(scale, 0.01))`; with Snap to Grid on, per axis the grid wins (`dropX` / `dropY`) unless a guide matched on that axis and is strictly nearer; `delta += adjustment`; every dragged node `moveNode(id:, to: clampWorld(start + delta), snap: false)`. After an ⌥-duplicate the anchor is the ORIGINAL node, which is not among the dragged copies, so no guide and no grid apply to an ⌥-drag (0.90.34's behaviour, reproduced).

### Keys (replicas of `CanvasClipView.keyDown` / `keyUp`)

| Op | Arguments | 0.90.34 |
|---|---|---|
| `arrowKey` | `key`: `left` / `right` / `up` / `down`, `shift` | step = `nudgeStep(coarse: shift)` (1 / 10, or 28 / 112 with Snap to Grid); with a node or link selected `nudgeSelection(by: direction · step)`, else `pan(by: −direction · 20 · (shift ? 4 : 1))` |
| `arrowKeyUp` | | `endNudgeRun()` |
| `tabKey` | `shift` | `selectAdjacentNode(reverse: shift)`, then `revealIfOffscreen` (pan the node inside an 88-point margin of the viewport) |
| `optionTabKey` | `shift` | `selectAdjacentLink(reverse: shift)`, then reveal both ends |
| `escapeKey` | | `deselectAll()` |
| `deleteKey` | | `deleteSelection()` |
| `returnKey` | | `openParameterEditorForSelection()` |

### Model methods (menus, context menus, the assistant's tools)

| Op | Arguments | 0.90.34 |
|---|---|---|
| `addNode` | `kind` (`station` / `buffer` / `source` / `sink`), `at` (world, not snapped), `name` (optional) | `addNode(kind:at:name:)` |
| `addLink` | `from`, `to`, `class` (0), `toClass` (none), `probability` (1) | `addLink(fromID:toID:customerClass:toCustomerClass:routingProbability:)` (no validation, as the assistant's tool) |
| `moveNode` | `node`, `to` (world), `snap` (default TRUE) | `moveNode(id:to:snap:)`: registers no undo of its own |
| `beginMutation` / `endMutation` | `name` / — | `beginMutation(_:)` / `endMutation()` |
| `moveLink` | `link`, `by` (world) | `moveLink(id:by:)` |
| `deleteNode`, `deleteLink` | `node` / `link` | `deleteNode(id:)` (the node context menu), `deleteLink(id:)` (Edit ▸ Delete Link, the link context menu) |
| `deleteSelection`, `copySelection`, `cutSelection`, `pasteSelection`, `duplicateSelection`, `selectAll`, `deselectAll` | | the methods of those names (Edit menu) |
| `setNodeSelection` | `nodes`: a list | `setNodeSelection(Set(nodes))` |
| `toggleNodeInSelection` | `node` | `toggleNodeInSelection(_:)` |
| `selectAdjacentNode`, `selectAdjacentLink` | `reverse` | the methods, without the reveal pan |
| `alignSelectedNodesLeft`, `…Right`, `…Top`, `…Bottom`, `…HorizontalCentres`, `…VerticalCentres`, `distributeSelectedNodesHorizontally`, `…Vertically` | | the methods of those names (Arrange menu) |
| `nudgeSelection` | `by` (world) | `nudgeSelection(by:)` |
| `endNudgeRun`, `endParameterRun` | | the methods |
| `straightenNetwork`, `fitNetworkToWindow`, `clear` | | Network ▸ Straighten Network, Straighten and Fit to Window, Edit ▸ Clear Canvas (the confirmation alert is the app's, before the call) |
| `setInfiniteBuffers` | `value` | `setInfiniteBuffers(_:)` (Network ▸ Buffer Model) |
| `renameNode` | `node`, `name` | `renameNode(nodeID:name:)` |
| `updateBufferSize` | `node`, `size` | `updateBufferSize(nodeID:size:)` |
| `updateNumberOfServers` | `node`, `count` | `updateNumberOfServers(nodeID:count:)` |
| `updateStationPicture` | `node`, `picture` (a `StationPicture` raw value; `""` is none) | `updateStationPicture(nodeID:picture:)` |
| `updateNodeDistribution` | `node`, `distribution` (a `QueueDistribution` raw value), `parameters` | `updateNodeDistribution(nodeID:distribution:parameters:)` |
| `updateServiceDistribution` | `node`, `class`, `distribution`, `parameters` | `updateServiceDistribution(nodeID:customerClass:distribution:parameters:)` |
| `updateLinkProbability` | `link`, `probability` | `updateLinkProbability(linkID:probability:)` |
| `updateLinkCustomerClass` | `link`, `class` | `updateLinkCustomerClass(linkID:customerClass:)` (the link context menu's class picker) |
| `updateLinkExitClass` | `link`, `class` (or `null`) | `updateLinkExitClass(linkID:exitClass:)` |
| `findAndRevealNode` | `query` | `findAndRevealNode(named:)` |
| `insertArchetype` | `archetype` (a `NetworkArchetype` raw value), `parameters`: any of `stations`, `servers`, `targetRho`, `feedbackProbability`, `infiniteBuffers`, `bufferCapacity`, `arrivalRate` over `ArchetypeParameters()` | the gallery's `onInsert`: `NetworkArchetypeBuilder.build`, then `insertSubnetwork(nodes:links:infiniteBuffers:at: canvasOrigin, actionName: "Insert " + title, detail: summary)` |
| `zoomIn`, `zoomOut`, `zoomToFit`, `zoomToFitSelection`, `resetZoom` | | the methods (View menu) |
| `setZoom` | `scale` | `setZoom(_:)` |
| `zoomAbout` | `scale`, `about` (display) | `zoom(to:about:)` |
| `pan` | `by` (display) | `pan(by:)` (a scroll) |
| `undo`, `redo` | | Edit ▸ Undo / Redo with no text field focused: `undoManager.undo()` / `.redo()`; when `canUndo` / `canRedo` is false the menu item is disabled, nothing is called and a note says so |
| `wait` | `seconds` | real time passes with the run loop turning |

### Inspectors

The field values are TEXT, typed into the draft as the form's controls do (`nameText`, `serversText`, `bufferSizeText`, `infiniteBuffersDraft`, `stationPicture`; a family is the picker: `DistributionDraft.changeDistribution(to:mode:)`; a parameter is the field: `setParam(key, text)`; `mean` / `scv` are the moments fields).

| Op | Arguments | 0.90.34 |
|---|---|---|
| `nodeSheet` | `node`; any of `name`, `servers`, `bufferSize`, `infiniteBuffers`, `picture`; `distribution: {family, params: {key: text}, mean, scv}` (the single law: a source, or a station no class reaches yet); `classes: {"<c>": {…}}` (a station's per-class rows); `entryMode` / `classEntryMode`: `native` or `moments` (`syncMode(to:)` then the mode); `copyToAllClassesFrom: c`; `cancel` | The ⌘I / double-click sheet: `openParameterEditor(for:)`, a new `NodeParameterDraft` `load(from:nodeID:)`, the fields, then Save = `commit(to:)` (no coalescing: one undo step "Edit <name> Parameters"), then `closeParameterEditor()`. When the draft is invalid Save is disabled: nothing is committed and a note gives `firstProblem` / `pendingNote`. `cancel` closes without committing |
| `nodePane` | the same fields, no `node` | The docked pane on the current selection (exactly one node): its persistent draft, the fields, then the blur: `commit(to:coalescing: true)` (`performCoalescedParameterEdit` keyed by the one changed field). A refused commit leaves the draft dirty, and the next selection change discards it with a warning |
| `linkSheet` | `link`; any of `probability` (text), `entryClass`, `exitClass` (an index, or `"same"`), `balance` (Balance to 1), `cancel` | `openLinkParameterEditor(for:)`, a new `LinkParameterDraft` `load`, the fields, Save = `commit(to:)`, `closeLinkParameterEditor()` |
| `linkPane` | the same fields, no `link` | the docked pane's link draft on the selected link, blur = `commit(to:coalescing: true)` |

Balance to 1 is `LinkInspectorSections.balanceButton`: remainder = 1 − Σ `siblingLinks(of:)` probabilities; enabled when the remainder is ≥ 0 and the total (siblings + this field) differs from 1 by more than 1e−6; it sets `probabilityText = DS.Number.fieldText(min(max(remainder, 0), 1))`. Disabled, it adds a note and changes nothing.

## `step-NN.json`

| Field | 0.90.34 |
|---|---|
| `step`, `op` | the step number and the op as written (keys sorted) |
| `status` | every `statusMessages` entry the step added, `{text, severity}` (`StatusEntry.text`, `.severity.rawValue`); File ▸ Save's own "Saved network to step-NN.bnet." line is not included |
| `selectedNodeID`, `selectedNodeIDs`, `selectedLinkID` | the selection (the set in document order) |
| `pendingLinkStartID`, `activeLinkSourceID`, `activeCustomerClass` | the Link tool's chain state |
| `selectedTool`, `toolBeforeStickyPan` | `EditorTool` raw values |
| `canUndo`, `canRedo`, `undoActionName`, `redoActionName` | `undoManager`'s (the Edit menu shows "Undo " + the name) |
| `snapToGrid`, `snapSuspended`, `classFilter`, `canvasScale`, `canvasPanOffset`, `infiniteBuffers` | the properties |
| `nodeCount`, `linkCount`, `numberOfCustomerClasses`, `canPaste` | the properties |
| `hasUnsavedChanges` | before the step's save |
| `multiSelectRect`, `isDraggingNode`, `parameterEditorTarget`, `linkParameterEditorTarget`, `pendingFitOnAppear` | the properties (`pendingFitOnAppear` is set by an insert and cleared only by the canvas, which is not running) |
| `alignGuides` | drags only: the `SmartGuides.Match` of the drag's frame (`adjustment`, `x`, `y`, `anchor`, `xPartner`, `yPartner`, `xSpacing`, `ySpacing`) |
| `marqueeNodeCount` | marquees only: `marqueeNodeCount` while the band was up |
| `notes` | what the replay did instead of a call (a disabled menu item, a disabled Save, a suppressed second click) |

## What is not replayed

- **A sink's self-loop sentence** ("Cannot link Sink1 to itself: …") and the second "Cannot link out of …" branch of `handleLinkSelection` are unreachable from the interface: the first click on a sink is refused, so a sink is never `pendingLinkStartID`. No scenario can show them.
- **Dragging a self-loop link** traps in 0.90.34: `canvasDrag` builds `[from.id: …, to.id: …]`, a dictionary literal with a duplicate key when both ends are one node. `dragLink` refuses it rather than crash.
- **The link-drag anchor** is `dragStartPositions.keys.first`, a dictionary's first key, which depends on the process's hash seed. `dragLink` computes the drag with each end as the anchor and fails the scenario if the two differ (a guide or the grid would catch one end and not the other); the scenarios avoid such positions.
- Hover, the cursor, the rubber-band line (`pendingLinkPoint`), the ghost node, Space-to-pan, the pinch / wheel handlers (they end in `zoom(by:about:)` / `pan(by:)`), right-click menus as menus (their items are the model calls above), the image export, tabs, the Save panel, Reopen Closed Tab, and the assistant.
- The flag bar's silent analysis, which `bnetNetworkParametersDidChange` triggers in the app after a 150 ms debounce: it writes no status line in quiet mode and does not touch the document.
