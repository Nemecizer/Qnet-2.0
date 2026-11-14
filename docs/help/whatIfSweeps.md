# WHAT-IF SWEEPS

A what-if sweep answers questions such as "what happens to the queue if arrivals grow?" or "how large must this buffer be?". It changes one parameter step by step, runs the methods you tick at every step, and plots how a measure responds.

## STARTING A SWEEP

Choose Run ▸ What-If Sweep…. The network needs at least a source and a station. The panel asks three things.

What to vary. One parameter; everything else stays as it is:

- the load factor, which multiplies every arrival rate (1 is the network as it is);
- a source's arrival rate;
- a station's service rate, per customer class where the station serves more than one;
- a station's number of servers;
- a buffer's size, in a finite-buffer network;
- a routing probability, where exactly one other link leaves the same node for the same class, so that link takes the rest.

Then the range: From, To and the number of points (2 to 60; the panel starts at 12). The panel shows the value the parameter has now. If part of the range would overload the network, the panel says where, and those points are left out.

Methods. Tick one or several. Only methods that apply to the network and are quick enough for a sweep are listed. The tooltip of each gives an estimate of the time for one point. A simulation runs every point afresh, so its time is set by the run length in Settings ▸ Discrete-Event Simulation and can be minutes.

What to plot first. The measure and the station the chart opens on. Every measure of every station is kept; you can switch afterwards.

Run Sweep starts it. The status bar counts the points, and Stop works throughout: the points that had finished are kept and shown.

## READING THE SWEEP VIEW

When the sweep ends, the Results pane shows its Sweep view: the measure against the parameter, with one line per method and a shaded 95 % interval where a method gives one.

- A vertical rule marked "now" shows the value the parameter has in the network.
- A rule marked "overloaded beyond" (or "below") shows where the network stops having a steady state. The measure grows without bound there.
- A point a method could not compute is left as a gap, and the table says why: overloaded, refused, failed, left out, not run or not reported.

Show as Table gives the same numbers with a row per point. The Measure and Station menus switch what is plotted without running anything again.

## USING THE RESULT

- Apply This Value: point at a value on the chart, or move to it with the arrow keys, then apply it. Qnet sets the parameter to that value in the network as one undo step.
- Sweep Again… opens the panel with this sweep's choices.
- Export Chart… saves the figure as PDF, PNG or SVG.
- Export Data… saves the points as a CSV file for a spreadsheet.

If you edit the network afterwards, the view notes that the network has changed since the sweep ran.

## TRY IT

[Example network: an open Jackson network with feedback (OpenJackson.d2.feedback.p30.inf)](qnet-example:OpenJackson.d2.feedback.p30.inf)

Open it, choose Run ▸ What-If Sweep…, keep the load factor and tick two methods. Watch the mean number in system climb steeply as the load approaches the "overloaded beyond" rule.
