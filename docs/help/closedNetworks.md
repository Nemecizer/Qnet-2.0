# CLOSED NETWORKS

In a closed network nothing arrives and nothing leaves. A fixed number of customers, the population N, move from station to station for ever. The classic examples are a computer with a fixed number of jobs in it (the central-server model), a group of machines that break down and are repaired, and a production line that keeps a fixed number of pallets in circulation.

A network is closed when it has no source and no sink, and a population is set.

## MAKING ONE

- Network ▸ New Closed Cycle puts three stations in a ring with six customers on the canvas, ready to solve. If the canvas is not empty it opens in a new tab.
- To close a network you have drawn, delete its source and its sink and lead the last station back to the first station's buffer. The Problems list then offers "Make this a closed network", which sets a population of two customers per station to start with. Network ▸ Make Closed Network does the same.
- File ▸ Open Example… has a central-server model in the folder "closed".

Every station still takes its work from its own buffer, so a link that returns customers goes to a buffer, never straight to a station. The routing probabilities out of each station must add up to 1, because a customer that leaves a station has to go somewhere.

[Example network: a central-server model with eight jobs (ClosedCentralServer.d3.N8)](qnet-example:closed/ClosedCentralServer.d3.N8)

The example opens with its exact results already on the canvas: three stations, eight customers, and a link that returns one customer in ten straight to the first station.

## THE POPULATION

Click an empty part of the canvas so that nothing is selected. The Inspector then shows the section Closed Network with the population. It is a whole number from 1 to 10000. Changing it is one undoable step, and the values on the canvas follow at once. Remove Population makes the network open again; it then needs a source and a sink.

The population is saved in the file. A file with a population cannot be solved by Qnet 2.0 or 0.90.34, which see a network without a source.

## WHAT QNET COMPUTES

For exponential service at every station, the network is a Gordon–Newell network and has an exact solution. Qnet computes it inside the app, with no solver process:

- the throughput of each station, in customers per time unit;
- the utilisation of each station, the fraction of time a server is busy;
- the mean number of customers at each station, and the mean number waiting;
- the mean time a customer spends at a station per visit, and the mean wait before service;
- the distribution of the number of customers at each station, printed in the Shell after a run.

Live results show these while you draw, with the chip "Live · exact". Solve records a run of the method Exact Closed Product Form, which then appears in the Results pane, in the charts and on the canvas like any other run.

Throughput in a closed network is counted in visits. Qnet takes the first station, the one with the lowest number in its name, as the reference station. The read-out names both figures for it: "Throughput at S1 (visits per time unit)" is the rate at which customers pass through S1, and "Cycle time between visits to S1" is the population divided by that rate, the mean time between one customer's successive visits to S1. A station visited twice per cycle has twice that throughput.

Every pass counts as a visit. In the example below a customer leaving S1 goes straight back to S1 one time in ten, and each such return is a visit of its own. The cycle time is therefore not the response time of a job: a job that needs several passes through S1 takes several cycles.

## HOW IT IS COMPUTED

Qnet uses two exact algorithms and compares them.

- Buzen's convolution algorithm builds the normalising constant G(N) of the product form station by station. The throughput is G(N−1)/G(N), and the same sums give the distribution at each station. It handles any number of servers.
- Mean Value Analysis adds one customer at a time. It rests on the arrival theorem: a customer arriving at a station sees the network as it would be with one customer fewer. It is used when every station has one server.

When every station has one server, a run prints how closely the two agree, which is to at least ten digits. With several servers at a station only the convolution algorithm is used. Both are checked in Qnet's tests against textbook formulas and published tables.

## A SECOND OPINION

An exact answer needs no confirmation, but it is worth seeing one. Run ▸ Check with Another Method simulates the closed network with [Replicated Simulation](help:replicatedSimulation), inside Qnet. The Agreement view then shows each exact value beside the simulation's estimate and its confidence interval, and says whether they agree. A simulation follows the customers one by one and uses none of the formulas above, so agreement shows that the network was read the same way twice.

Run ▸ Run Replicated Simulation… does the same and first asks for the number of replications, the run length, the confidence level and the seed.

## WHAT TO EXPECT

With one customer there is never a queue. As the population grows, throughput rises, quickly at first and then more slowly, and levels off at the capacity of the busiest station, the bottleneck. Beyond that point more customers only wait longer. A closed network cannot be overloaded: utilisation is always below 100 %.

Run ▸ What-If Sweep… can vary the population. Throughput against population is the curve to look at: the bend shows how many customers the network can usefully hold.

## WHAT IS NOT COVERED

- One customer class only.
- Exponential service only. With another distribution there is no exact formula, and Qnet says so rather than guess.
- With finite buffers, every station must have room for the whole population (buffer size plus servers). Otherwise customers would be blocked and the exact solution does not hold. Use infinite buffers, or a buffer at least as large as the population.
- The other methods, apart from Replicated Simulation, need arrivals from a source. For a closed network they are unavailable, and the Run menu and the Method Chooser say why.

## PROBLEMS QNET POINTS OUT

- A routing row that adds up to less than 1: customers would leave, and nothing brings them back.
- A station that customers leave and never return to: in the long run it stands empty.
- Stations in separate groups that never exchange customers: the long-run behaviour would depend on where the customers start.
- A population on a network that still has a source or a sink: it is solved as an open network and the population is not used.
