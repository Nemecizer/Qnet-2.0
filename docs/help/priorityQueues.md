# PRIORITY SERVICE

Normally a station serves its customers in the order they arrive, whatever their class. With priority service a free server takes the waiting customer of the highest class first. An emergency ward, a help desk with urgent and routine tickets and a processor with interactive and batch jobs all work this way.

Priorities need customer classes. In Qnet each source is a class: Class 1 is the first source, Class 2 the second, and so on. A station with one class can be given a priority discipline, but it changes nothing.

## SETTING IT

Select a station. Below the service-time fields the Inspector has the section Service Order.

- Discipline chooses between First come, first served (the default), Priority, non-preemptive and Priority, preemptive-resume.
- With a priority discipline the classes are listed in order, the highest first. Move a class with its up and down buttons, or put the keyboard focus on its row and press Option with the up or down arrow key. Each move is one undoable step.

Within one class, customers are served in the order they arrive.

- Non-preemptive: a service that has started is finished. A high-class customer that arrives while a low-class customer is being served waits for that service to end, and then goes first.
- Preemptive-resume: a high-class customer interrupts a low-class one at once. The interrupted customer goes back to the head of its class and later carries on where it stopped. No work is lost or repeated.

On the canvas a station with priority service carries a small mark with the letter P at its bottom-left corner, and its tooltip, the Canvas Outline and VoiceOver say which discipline it has. The setting is saved in the file. Qnet 2.0 and 0.90.34 ignore it and read the station as first come, first served.

## THE EXACT RESULT

For one station fed directly by Poisson sources, with infinite buffers and no feedback, the mean values have exact formulas. Qnet computes them inside the app. Live results show the station's totals with the chip "Live · exact", and Solve records a run of the method Exact Priority Queue. The run's text in the Shell gives each class its own arrival rate, load, mean wait, mean time at the station and mean number.

- One server, non-preemptive, any service-time distribution with a finite variance: Cobham's formula. The mean wait of the class in place k of the order is W₀ / ((1 − σₖ₋₁)(1 − σₖ)), where W₀ is the mean remaining service time an arriving customer finds and σₖ is the utilisation of the first k classes together.
- One server, preemptive-resume, any service-time distribution with a finite variance: the same idea, except that a class does not see the classes below it at all.
- Several servers, exponential service at the same rate for every class, either discipline.

For a preemptive-resume station the "wait" is all the time a customer is at the station without being served: before its first start and during interruptions.

Sources: Cobham (1954); Kleinrock, Queueing Systems, volume 2, chapter 3; Kella and Yechiali (1985) and Buzen and Bondi (1983) for several servers.

## WHAT PRIORITIES DO AND DO NOT CHANGE

The station's utilisation does not depend on the order of service. Neither does the total work waiting. Priority only decides who waits: the high classes wait less and the low classes wait more, and the load-weighted average of the waits stays the same (Kleinrock's conservation law). Serving the class with the shortest service time first lowers the mean number of customers at the station; serving the longest first raises it.

[Example network: a help desk with urgent and routine tickets (PriorityHelpDesk.mg1.2class)](qnet-example:extended/PriorityHelpDesk.mg1.2class)

The example shows it: a help desk with urgent tickets (Class 1) and routine ones (Class 2). It is also in the Welcome view's gallery, and File ▸ Open Example… has it in the folder "extended". Swap the two classes and Solve again.

## A SECOND OPINION

Run ▸ Check with Another Method simulates the station with [Replicated Simulation](help:replicatedSimulation), which follows the priority order and, under preemptive-resume, remembers how much service an interrupted customer has left. The Agreement view shows the exact values beside the simulation's estimates and their confidence intervals. The simulation's text in the Shell has a table per class as well.

Run ▸ Animate shows the order of service: a high-class customer moves to the front of the queue, and under preemptive-resume the customer in service steps back into the queue.

## WHAT IS NOT COVERED

- The exact formulas are for a single station only. The customers that leave a priority station do not form a Poisson stream class by class, so the formulas say nothing about a station further on. For a network with a priority station and other stations, use Replicated Simulation; the Method Chooser and Solve do this.
- Several servers with different service rates per class, or with service times that are not exponential, have no formula. Replicated Simulation handles them.
- Every other method (QNA, the diffusion methods, product form, the CTMC methods and the rest) reads a network as first come, first served. On a network with priority service each of them refuses to run and says why, rather than answer for a different network. So do Sensitivity, Uncertainty, Capacity planning and the Transient view.
- A station whose classes together offer as much work as it can do, or more (utilisation 1 or more), has no steady state as a whole. No station result is given and Replicated Simulation refuses the network. With preemptive-resume a class is never delayed by the classes below it, so the higher classes whose load, counted from the top, stays under 1 do keep a steady state: the refusal names them with their exact mean time at the station, and names the classes that fall behind without limit. Without preemption no formula is offered when the total load is 1 or more.
- Closed networks have one class, so a priority discipline there is reported in Problems.
- A scenario cannot change the discipline or the order yet: they are the same in every scenario of a file.

## PROBLEMS QNET POINTS OUT

- A priority order that leaves out a class served at the station.
- A priority order that names a class twice, or a class the network does not have.
- A priority discipline in a closed network.
