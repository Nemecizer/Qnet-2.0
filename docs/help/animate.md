# ANIMATE

View ▸ Animate plays one random run of the network on the canvas. Customers appear at the sources, travel along the links, wait in line at the buffers, are served and move on. It is the quickest way to see what a queue is, why a busy station holds a line even though it keeps up on average, and what a bottleneck does to the stations around it.

The Animate button in the status bar of the canvas does the same. Choose it again, or press the close button of the animation's bar, to return to the drawing.

## WHAT YOU SEE

- Each customer is a small token. Its colour and its shape show its class: Class 1 is a circle, Class 2 a square, Class 3 a triangle, Class 4 a diamond, Class 5 a plus, Class 6 a triangle pointing down, Class 7 a ring and Class 8 a flat bar, each with its own colour. From Class 9 the shapes and colours start again. With more than one class the bar shows the key.
- A station's queue is drawn as a row above its buffer, the next customer to be served nearest the station. The first six are drawn one by one; a longer queue ends in a count such as +12.
- A station's servers are the rings above it: empty when idle, holding a customer's token when busy. A station with more than six servers shows the first six and the number busy, such as 9/12.
- The number beside each station is how many customers are there now, waiting and in service.

While the animation is on, the values and colours of Results on the Canvas, the utilisation badges and the problem marks are hidden so the picture stays readable. They return when you leave animation mode. The Problems count in the status bar stays.

## THE CONTROLS

- Play and Pause. With the keyboard on the canvas, Space does the same.
- Restart starts the same run again from time 0: the same seed, so the same customers at the same times.
- New Run starts from time 0 with a new random seed: a different run of the same network. The seed is shown in the bar.
- Speed runs from 0.25× to 64×. At 1× about two services finish each second, whatever the network's own time unit; the Speed control's tooltip gives the time units per second.
- Skip Ahead jumps forward by about a thousand service completions without drawing what happens on the way. Use it to get past the start.
- The clock shows simulated time, in the network's time units.

## THE STRIP CHART AND THE AVERAGES

The chart in the bar shows the number of customers at one station over the last stretch of the run. Select a station on the canvas to chart it; with nothing selected it charts the first station.

Beside the chart are the number at the station now and its time average since the start of the run, with the time it has been averaged over, for example "average 2.104 customers after t = 153.2 time units".

When a formula gives the exact long-run mean, the chart shows it as a dashed line and the bar gives its value. This is the mean that Live Results shows: for an open Jackson network, and for a closed network with exponential service. Watch the run wander round the line: a single run is noisy, and its average settles slowly.

Early averages are biased by the start. An open network starts empty, with no customer anywhere, and each source's first customer arrives after one ordinary inter-arrival time counted from time 0, drawn from that source's distribution. So its averages begin too low. A closed network starts with every customer at the first station.

## AN ILLUSTRATION, NOT A RESULT

The animation is one random run. It gives no confidence interval, and its averages are never used in Results or in the comparison of methods. For results use Solve. For a simulation with confidence intervals use [Replicated Simulation](help:replicatedSimulation), which runs this same simulator many times and says how sure each number is.

The run is still a correct simulation of the network as drawn. Arrival and service times are drawn from the distributions you chose, each station serves first come, first served with its number of servers, and customers follow the routing probabilities and class changes of the links.

## NETWORKS THAT CAN BE ANIMATED

- Open networks with infinite buffers, with any of Qnet's distributions and any number of classes.
- Closed networks that have a population, one class and exponential service: the networks the closed-network solution covers. The customers start at the first station.

Open networks with finite buffers are not animated. What happens at a full buffer depends on a blocking rule, loss or blocking after service, which you choose for each run of a finite-buffer method and which is not part of the network. The bar says so and names the way forward: choose Network ▸ Buffer Model ▸ Infinite buffers to animate the network, or keep finite buffers and use Run ▸ Solve. A new, empty network starts with finite buffers, so a network drawn from scratch needs this switch before it can be animated. Any other network that cannot be animated says why in the bar, in the same words as Network ▸ Analyze Network.

## A NETWORK WITH NO STEADY STATE

If work arrives at a station as fast as it can be served, or faster, the animation still runs, and a banner says that no steady state exists. The queue at that station keeps growing for as long as the run goes on. This is worth showing: compare it with the same network after you add a server.

Such a run cannot go on for ever. When more than 1,000,000 customers are waiting in the network the animation stops and the bar says which queue passed that size, for example "The queue at S1 has passed 1,000,000 customers; the animation has stopped." Skip Ahead reaches this quickly in an overloaded network. After a skip a very long queue is drawn as its count; the customers at its head are drawn one by one only for the first few hundred.

## EDITING WHILE ANIMATING

You can keep editing. Moving a node moves the animation with it. Changing the network itself, such as a rate, a link, a node or the number of servers, starts the run again from time 0 with the same seed, and the bar says so.

The animation never changes the network, is not saved with it, and is not part of an exported diagram.

## REDUCE MOTION

With Reduce Motion on, in Qnet's settings or in macOS, customers are not drawn travelling. The queues, the servers and the counts update in steps, twice a second, and the bar says so. The clock, the chart and the averages work as before.
