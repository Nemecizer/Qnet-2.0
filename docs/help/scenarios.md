# SCENARIOS

A scenario is a named variant of one network: the same stations and links with other numbers. "Add a server at S2" and "Peak hour" are scenarios. The network's own values are the Baseline. Scenarios let you keep several what-if cases in one file and compare them in one table and one chart.

## WHAT A SCENARIO CAN CHANGE

A scenario changes parameter values only:

- an arrival or service distribution and its parameters, such as a rate;
- the number of servers at a station;
- a buffer's size;
- a routing probability;
- the population of a closed network.

The network itself is shared by every scenario: which nodes and links exist, their names, their customer classes, their places on the canvas, and whether buffers are finite or infinite.

## MAKING AND SHOWING SCENARIOS

The toolbar button beside Solve always shows the name of what is on the canvas: Baseline, or the scenario's name. Click it for the menu.

- Baseline and each scenario are listed; the one shown is ticked. Choose another to show it. The canvas, the inspector, live results and Solve then use its values.
- New Scenario from Current Values… keeps the values shown now under a name and shows the new scenario.
- Rename…, Duplicate… and Delete act on the scenario shown. Deleting it shows the Baseline again.
- Compare Scenarios… opens the comparison.

Each of these is one step for Edit ▸ Undo.

## EDITING WHILE A SCENARIO IS SHOWN

A value you change while a scenario is shown belongs to that scenario. The Baseline and the other scenarios keep their values. In the inspector, a field the scenario changes has a small dot and a line such as "Baseline: 1", with a Reset to baseline button that puts the Baseline's value back.

A value you change while the Baseline is shown is the Baseline's new value. Every scenario that does not change that field follows it.

Adding, deleting or reconnecting nodes and links changes the network for every scenario. Qnet says so once in the Status pane. If you delete a station or link that a scenario changed, that change is dropped, and a Status line names the scenario.

## RUNS AND SCENARIOS

A run belongs to the values it was made from. Its result reads as current while the scenario it was made under is shown, and as "network changed since this run" under any scenario with other values. Two scenarios with exactly the same values share their results, because they are the same network.

## COMPARING SCENARIOS

Compare Scenarios… opens a window with one column for the Baseline and one for each scenario. The rows are the mean number in the network, the mean delay through the network, the throughput, and each station's utilisation and mean queue length.

- Each cell comes from that scenario's best current run. Where a scenario has no run and the network has an exact formula, the cell shows the formula's value, marked "Exact (formula)".
- Every cell names its tier: Exact, Simulation, Approximation, Diffusion model or Bound.
- Under each scenario's value is its difference from the Baseline, as a number and as a percentage.
- A row whose cells come from different tiers carries a warning sign. Part of a difference in such a row may come from the method and not from the scenario.
- A dash means no current result gives that measure for that scenario.

Solve All Scenarios runs Solve for the Baseline and each scenario in turn, then shows again what was shown before. Stop ends it after interrupting the run in progress. A scenario whose result is already current is not run again.

The chart under the table draws one measure as grouped bars, one bar per scenario. Choose the measure from the Chart menu. Export Data… saves the table as a CSV file, and Export Chart… saves the chart as a PDF, PNG or SVG file.

## SAVING A PROPOSAL AS A SCENARIO

In Results ▸ Capacity and Results ▸ Sensitivity, Save as Scenario stands beside Apply. It makes a new scenario that holds the proposed change, and leaves the values shown before as they were in the Baseline and the other scenarios.

## IN THE FILE

Scenarios are saved in the .bnet file. A file with no scenarios is saved exactly as before. The file's network is always the one last shown, so Qnet 0.90.34 and 2.0 open such a file as that network. They do not show the scenarios, and they drop them if they save the file.

The command-line tool and the Python package read the same file. Without being told otherwise they read the network as it was last shown, and say so when that is a scenario: every document qnet-cli prints then carries the warning "This file was saved showing the scenario “Peak hour”; these numbers are that scenario's." To choose, give qnet-cli the option --scenario with a scenario's name, or --scenario baseline; in Python, qnet.Network.open(path, scenario="Peak hour"). Both keep the scenarios when they save the file, and refuse to save, rather than lose them, when nodes or links were added or removed.

## TRY IT

[Example network: an open Jackson network with feedback (OpenJackson.d2.feedback.p30.inf)](qnet-example:OpenJackson.d2.feedback.p30.inf)

Open it and choose New Scenario from Current Values… from the toolbar button. Name it "Add a server at S2", select S2 and set its servers to 2. Then choose Compare Scenarios…. The Baseline's mean number in the network is 4.667, and the scenario's is lower.
