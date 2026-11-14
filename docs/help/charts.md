# CHARTS

The Results pane has a Charts view that draws a run's values as a figure. Switch to it with the view control at the top of the Results pane (Table, Agreement, Charts, Sweep). It is offered once a run on the tab has completed.

## ONE METHOD

One Method draws one run's values station by station as bars, for the quantity you choose. You pick the run and the quantity from the two menus of the view.

- When the method gives an interval, each bar has whiskers for it.
- When the run reports values per customer class, there is one bar per class.
- The caption under the chart names the highest station.

## ALL METHODS

All Methods draws every current method's value for each station on one axis: a dot for the value and a line for its interval where the method gives one. The reference (the exact value, or else the simulation) is marked, so you can see at a glance which methods sit on it and which do not. The caption repeats the verdict of the Agreement view: agree (within 2 %), close (within 10 %) or disagree.

Runs made before the network changed are left out, and the chart says how many. If only one method has run, the chart offers Check with Another Method.

## READING A CHART WITHOUT SEEING IT

Every chart has a caption sentence and a table of the same numbers for screen readers. The colours follow the kind of method, and each kind also has its own mark shape.

## EXPORTING A FIGURE

- Export Chart… saves the chart as a PDF, PNG or SVG file. The file name you type decides the format; without one of those three extensions it is a PDF. The figure is always drawn in the light appearance on white, whatever the app shows, so it is ready for a report.
- Copy Chart puts the chart on the clipboard as an image (PDF and TIFF), to paste into a document or a slide.

Both buttons are in the Charts view. They are also in the Command Palette (⇧⌘K): type "export chart" or "copy chart".

The What-If Sweep's chart has its own Export Chart… button, described in [What-If Sweeps](help:whatIfSweeps).

## TRY IT

[Example network: an open Jackson network with feedback (OpenJackson.d2.feedback.p50.inf)](qnet-example:OpenJackson.d2.feedback.p50.inf)

Open it, choose Run ▸ Run Recommended Methods, then open Charts and switch to All Methods: each station has one row, and the dots that sit on the reference are the methods that agree.
