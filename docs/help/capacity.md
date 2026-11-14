# CAPACITY PLANNING

The Capacity view answers "how many servers do I need?". You state a target, such as a mean delay of at most 3 time units, and what a server costs at each station. Qnet finds the cheapest numbers of servers that meet the target, and shows what each extra unit of cost buys.

## OPENING IT

Choose Run ▸ Plan Capacity…, or switch the Results pane to Capacity. The network needs a source, a station and a sink. A network that is overloaded as drawn can be planned: finding the servers it needs is what the view is for.

## STATING THE PROBLEM

Targets. Tick one or several, and type a value for each. The plan meets all of them.

- Mean delay through the network: the average time from arrival to departure.
- Mean number in the network: the average number of customers, waiting or in service.
- Utilisation of every station: the fraction of time each server is busy, as a percentage.
- Mean wait before service at one station: the average time in that station's queue.

Beside each target the view shows its value now. When the view first opens it suggests a delay target one fifth below the delay now.

Stations and costs. For each station, say whether it may change, what one server costs there (1 unless you type another number), and the fewest and the most servers it may have. A station that may not change keeps the servers it has.

## READING THE PLAN

- One sentence says what to do, for example "Add 1 server at S1: the cost rises from 2 to 3, the least that meets every target."
- The plan table lists, for each station, the servers now, the servers proposed, the change and the cost, with the total cost now and proposed.
- The targets table gives each target's value now and under the plan, with its unit.
- Apply changes the network to the plan as one undo step, named Apply Capacity Plan in the Edit menu.
- Try as What-If Sweep… opens the sweep panel on the station that changes most.

The chart is the trade-off curve: total cost across, mean delay up. Each point is a plan with one more server than the point before, always placed where it helps most. The curve falls steeply at first and then flattens: the first extra servers remove most of the waiting, and later ones buy very little. The target is drawn as a level line, the network as it is now as a single point, and the proposed plan as a vertical rule.

## WHY THE ANSWER IS THE CHEAPEST

If the network is an open Jackson network (Poisson arrivals, exponential service times, infinite buffers and one customer class at each station), each station behaves as an M/M/c queue whose arrival rate does not depend on the numbers of servers. Two facts then do the work.

- The mean number at a station falls as servers are added, and falls by less each time. So a target on one station (its utilisation or its wait) is simply a smallest number of servers there.
- A target on the whole network adds the stations up. Giving each next server to the station where it cuts the mean number most per unit of cost is called marginal allocation. When servers cost the same everywhere, the first plan on this path that meets the target is a cheapest one. The view then says "Proven cheapest".

When servers cost different amounts, a mix of cheaper servers can beat the path. Qnet then checks every plan that costs no more than the path's answer. If that exact search finishes, the view says "Proven cheapest" and how many candidates it checked. If the problem is too large for the search (more than 2,000,000 candidates), the view says "Good, not proven best".

## TARGETS THAT CANNOT BE MET

The view explains why no plan exists.

- A delay target at or below the service itself. Servers remove waiting, not service. With unlimited servers the mean delay approaches the sum of the mean service times a customer meets on the way, and never goes below it. The view shows this floor beside the delay target. To go lower, make the service faster.
- A limit or a held station stands in the way. The view names the station and the best value its limit allows.

## SERVICE RATES

Choose Service rates at the top of the view to plan how fast each station works instead of how many servers it has. Type the cost of one unit of service rate at each station. This needs single-server stations and a target on the whole network (mean delay or mean number).

The answer is Kleinrock's square-root rule. Each station first gets the rate it cannot do without, which is its arrival rate λ. The rest of the budget is shared in proportion to the square root of λ divided by the station's cost. For two stations with arrival rates 1 and 4, equal costs and a target of 3 customers in the network, the rates are 2 and 6: the busier station gets twice the extra capacity, not four times. Apply writes each rate rounded up at the sixth significant digit, so the target is still met.

## NETWORKS WITH NO CLOSED FORMULA

For any other network, press Plan by Solver Runs. Qnet runs the same search, one more server at a time, and solves the network once for each plan it tries, using the method that Solve would choose. It uses at most 60 runs. While it works the status bar shows it as Capacity, and Run ▸ Stop ends it and keeps the best plan reached.

This route is marked Experimental. The plan carries the method's tier (exact method, approximation or diffusion model) and is good but not proven best. Qnet does not search with a simulation, because the difference one server makes is smaller than a simulation's run-to-run noise. Service rates are not planned on this route. A closed network, in which a fixed number of customers circulates and nothing arrives from outside, is not planned.

## TRY IT

[Example network: an open Jackson network with feedback (OpenJackson.d2.feedback.p30.inf)](qnet-example:OpenJackson.d2.feedback.p30.inf)

Open it and choose Run ▸ Plan Capacity…. Each station has one server at 70 % utilisation and the mean delay is 4.667. A target of 3.2 takes one more server; a target of 2 takes one more at both stations; a target of 1.4 or less cannot be met, because 1.4 is the service time itself.
