# SENSITIVITY AND BOTTLENECKS

The Sensitivity view answers "what should I change?". For one measure of the network it shows which parameter moves that measure most, which station is the bottleneck, and what single change would reach a target such as "cut the mean delay by 10 %".

## OPENING IT

Choose Run ▸ Sensitivity…, or switch the Results pane to Sensitivity. The network needs a source, a station and a sink. Pick the measure in the menu at the top of the view:

- the mean number of customers in the network;
- the mean delay through the network, from arrival to departure;
- for each station, its mean number in system, mean queue length, mean sojourn time and utilisation.

The parameters are the ones a what-if sweep can vary: each arrival rate, each service rate, each number of servers and each routing probability where exactly one other link takes the rest.

## READING THE CHART

Each bar is the elasticity of the measure in one parameter: the percentage change in the measure for a 1 % change in the parameter. Elasticities have no unit, so parameters of different kinds can be compared. The largest is at the top.

- A bar to the right of zero raises the measure. A hatched bar to the left lowers it. The sign is also written beside every bar.
- A sentence under the chart reads the leading bars in words, for example "Raising the S2 service rate by 1 % shortens the average delay through the network by about 3.2 %; it is the bottleneck."
- The bottleneck is the station with the highest utilisation. If several stations tie, the view says the network has no single bottleneck.

Show as Table lists every number: the value now, the derivative (the change in the measure per unit change in the parameter, with its unit) and the elasticity.

A number of servers is a whole number, so it has no derivative. For each station the view gives the exact effect of one more server instead.

## HOW SURE THE NUMBERS ARE

The line above the chart always says where the numbers come from.

Exact — closed formula. If the network is an open Jackson network (Poisson arrivals, exponential service times, infinite buffers and one customer class at each station), Qnet differentiates its exact formulas. For one M/M/1 queue with arrival rate λ, service rate μ and utilisation ρ = λ/μ, the mean number in system is L = ρ/(1 − ρ), so dL/dλ = 1/(μ(1 − ρ)²) and the elasticity is 1/(1 − ρ). At ρ = 0.9 a 1 % rise in arrivals raises L by about 10 %. For a network, Qnet differentiates the traffic equations to see how every station's arrival rate moves, then the M/M/c formula of each station. Nothing is run, and the view follows every edit at once.

Numerical derivative. For any other network no closed formula applies. Press Estimate Sensitivities and Qnet solves the network again with each parameter 0.5 % lower and 0.5 % higher, using the method that Solve would choose, and takes the difference. The view says how many runs this needs before it starts. While it works the status bar shows it as Sensitivity, and Run ▸ Stop ends it. The mean delay through the network is the mean number divided by the total arrival rate of the network each run solved, so its sensitivity to an arrival rate is the delay's own: for one M/M/1 queue at ρ = 0.8 the elasticity of the delay is 4, where that of the mean number is 5. The result carries that method's tier (exact method, approximation or diffusion model): the numbers are as good as the method is for this network. This route is marked Experimental.

Qnet does not differentiate a simulation. A derivative is the small difference between two runs, and a simulation's run-to-run noise is larger than that difference. If only a simulation applies, use a what-if sweep over a wider range and read the trend with its intervals.

## WHAT WOULD IT TAKE

Choose Cut or Raise and type a percentage. For each parameter on its own, Qnet finds the value that moves the measure by that much and lists the options from the smallest relative change to the largest. Each option shows the value now, the proposed value and the measure that the proposed value gives when the network is solved again with it.

- Apply sets the parameter in the network as one undo step, named Apply Sensitivity Value in the Edit menu.
- Try as What-If Sweep… opens the sweep panel on that parameter, from its value now to the proposed one.
- Under "Cannot do it alone" are the parameters that cannot reach the target, with the reason: no effect on this measure, not enough even at the end of its range, or a station would be overloaded first.

A number of servers moves in whole steps, so its option is the first count that reaches or passes the target.

On the exact route the options appear at once. On the numerical route, press Work Out the Options: Qnet searches the five most influential parameters with at most six runs each, and accepts a value when it is within 2 % of the change you asked for.

## TRY IT

[Example network: an open Jackson network with feedback (OpenJackson.d2.feedback.p30.inf)](qnet-example:OpenJackson.d2.feedback.p30.inf)

Open it and choose Run ▸ Sensitivity…. Both stations run at 70 % utilisation. The arrival rate has the longest bar, and a 10 % cut in the mean delay takes about 5 % fewer arrivals or about 7.5 % more service at either station.
