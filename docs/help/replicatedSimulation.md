# REPLICATED SIMULATION

Replicated Simulation estimates the long-run behaviour of a network by simulating it, and says how sure each number is. Qnet computes it inside the app, with the simulator that View ▸ Animate plays, so it needs no solver to be installed.

It is the second opinion for a closed network: the exact solution says what the numbers are, and an independent simulation that lands on them shows that the model was read the same way twice. It is also a simulation for open networks with infinite buffers.

## WHAT IT COMPUTES

For every station, each with a confidence interval:

- the throughput, in customers per time unit;
- the utilisation, the mean fraction of busy servers;
- the mean number of customers at the station, and the mean number waiting;
- the mean time a customer spends at the station per visit, and the mean wait before service.

With several customer classes the numbers are for all classes together.

The run appears in the Results pane with the tier "simulation", in the Agreement view, in the charts and on the canvas. An exact value that lies inside the simulation's interval counts as agreement.

## HOW IT WORKS

The method is called independent replications.

1. Qnet simulates the network several times, each time with different random numbers. One such run is a replication. Twenty are made unless you ask for another number.
2. The start of every replication is deleted. A run begins in a state the network is rarely in: an open network starts empty, a closed network starts with every customer at the first station. Averages taken over that start would be biased. This deleted start is the warm-up.
3. Over the rest of a replication Qnet takes time averages, such as the mean number at a station. Each replication gives one value.
4. The estimate is the mean of those values. The interval is mean ± t × s / √R, where R is the number of replications, s is the standard deviation of their values, and t is the quantile of Student's t distribution with R − 1 degrees of freedom.

Because the replications use separate random numbers, their values are independent, and that is what makes the interval honest. A single long run cut into pieces does not have this property: neighbouring pieces resemble each other, and an interval that ignores this is too narrow.

Qnet always uses Student's t and never the normal value 1.96. With 20 replications t is 2.093 at 95 %; with 5 it is 2.776.

## THE WARM-UP RULE

By default Qnet finds the length of the warm-up from the runs themselves, with the MSER rule applied to 200 batch means. It averages the replications, cuts the average into 200 pieces of equal time, and looks for the cut that leaves the steadiest remainder: the one for which the standard error of what is kept is smallest. It does this for each station and deletes the longest warm-up found, from every replication alike. (The simulation literature also has a rule called MSER-5, which groups the single observations of one run in fives. Qnet's rule uses the same measure on its 200 time averages and is not that rule.)

The rule may delete at most half of a replication. If it would have deleted more, the replications are too short for it to see where the warm-up ends. Qnet then deletes half, and the Status pane and the run's warnings say that the runs should be longer.

You can choose a fixed fraction instead, for example 0.1 to delete the first tenth of every replication.

## THE SETTINGS

Run ▸ Run Replicated Simulation… opens a sheet with these values.

- Replications: how many independent runs. More replications make the interval narrower.
- Run length: service completions per replication, counted over the whole network. The default is 200,000. Longer replications make the interval more trustworthy, because the average of a long run is closer to a normal distribution.
- Warm-up rule: MSER on 200 batch means, or a fixed fraction.
- Confidence level: 90 %, 95 % or 99 %.
- Target relative half-width: leave it at 0 to run exactly the replications asked for. A value such as 0.02 asks Qnet to add replications until every station's mean number is known to within 2 % of its value. It starts from at least ten replications and adds them in a few large steps.
- Maximum replications and maximum wall time: where a run with a target stops if the target is out of reach. Such a run is recorded as partial: its intervals are valid but wider than you asked for.
- Use fixed seed and base random seed: with a fixed seed the run gives the same numbers every time, on any Mac. There is one exception: a run with a target that stops on the maximum wall time. How many replications fit in that time depends on the speed of the Mac, so the seed alone does not reproduce such a run. Its output and the warnings of its record say so, and say how many replications were made.

Solve and Check with Another Method run it with the default values and do not show the sheet.

The status bar shows progress while the run is going, and Run ▸ Stop Run stops it.

## HOW IT IS CHECKED

Qnet's tests run the whole method 200 times, with 200 different seeds, on networks whose exact answer is known: an M/M/1 queue at 50 % and at 90 % load, an M/M/3 queue, an open network with feedback, a closed cycle and the central-server example. For each number they count how often the 95 % interval contains the exact value. It should do so about 190 times in 200, and the tests accept 182 to 198. Other tests check that the warm-up rule removes the bias of the starting state, that a seed reproduces a run exactly, and that the t values match the published table.

## WHEN TO BE CAREFUL

- At high load a queue changes slowly, and a replication must be long compared with that. Above about 95 % utilisation, lengthen the run: ten times as many completions is a reasonable start.
- Service times with a very heavy tail, such as a Pareto distribution with shape 2 or less, make averages settle slowly, and the intervals can be too narrow.
- A target half-width close to 0 can need a great many replications. The safeguards stop the run and say so.

## WHAT IS NOT COVERED

- Open networks with finite buffers. What happens at a full buffer depends on a blocking rule, which is chosen for each run and is not part of the network. Use Run ▸ Run Monte Carlo… for those: its sheet asks for the rule.
- A network in which work arrives at a station as fast as it can be served, or faster. It has no long-run average to estimate, and Qnet says so.
- Closed networks other than those the exact closed-network solution covers: one class, exponential service, room for every customer at every station.

For an open network Qnet still recommends Monte Carlo first, as before; Replicated Simulation is listed as applicable beside it.

## TRY IT

Choose File ▸ Open Example… and open ClosedCentralServer.d3.N8 from the folder "closed". Press ⌘↩ to solve it exactly, then choose Run ▸ Check with Another Method. The Agreement view shows each exact value beside the simulation's estimate and its interval.
