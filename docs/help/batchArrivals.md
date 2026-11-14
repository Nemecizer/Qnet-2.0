# BATCH ARRIVALS

Customers do not always arrive one at a time. A bus unloads a group, a lorry delivers a pallet of parts, a message arrives as several packets. A source with batch arrivals models this: at each arrival epoch a random number of customers arrive together.

## SETTING IT

Select a source. Below the inter-arrival fields the Inspector has the section Batch Arrivals. Arrive chooses how many customers come at each epoch:

- One at a time: the default.
- In batches of a fixed size: every batch has the same whole number of customers.
- In batches of geometric size: the size is 1, 2, 3, … with probabilities that fall by a constant factor. You give the mean, 1 or more.
- In batches with given probabilities: you type the probabilities of sizes 1, 2, 3, … separated by commas. They must add up to 1.

The inter-arrival law above then times the batches, not the customers. The section shows the mean batch size and the average number of customers per time unit.

On the canvas a source with batches carries a small mark "×n" at its bottom-left corner, and its tooltip and the Canvas Outline say so in words. The setting is saved in the file. Qnet 2.0 and 0.90.34 ignore it and read single arrivals.

## THE LOAD COUNTS CUSTOMERS

The arrival rate that loads the stations is the batch rate times the mean batch size. Qnet uses this rate for the utilisation on the canvas, in the Inspector's stability read-out, in the status bar and in Problems. A source of 0.24 batches per time unit with a mean batch size of 2.5 sends 0.6 customers per time unit.

Batches make queues longer than single arrivals at the same customer rate, because the customers of a batch arrive at the same instant and must wait for one another.

## THE EXACT RESULT

For one Poisson source that feeds one single-server station, with infinite buffers and no feedback, the mean values have an exact formula (the M^X/G/1 queue), for any service-time distribution with a finite variance. Live results show them with the chip "Live · exact", and Solve records a run of the method Exact Batch-Arrival Queue.

The mean wait before service of a customer is the sum of two parts, and the run's text in the Shell prints both:

- the wait until its batch reaches the server, which is the usual single-server formula applied to whole batches;
- the wait behind the customers of its own batch that are served before it.

With exponential service the mean number at the station is ρ·(E[X] + E[X²]) / (2·E[X]·(1 − ρ)), where X is the batch size and ρ the utilisation. For batches of a fixed size K this is (K + 1)/2 times the M/M/1 value.

Sources: Chaudhry and Templeton, A First Course in Bulk Queues (1983); Gross, Shortle, Thompson and Harris, Fundamentals of Queueing Theory, chapter 3.

[Example network: batches of geometric size, mean 2.5, into one exponential server (BatchArrivals.mx-m-1.geometric)](qnet-example:extended/BatchArrivals.mx-m-1.geometric)

The example is the source described above feeding one exponential server. It is also in the Welcome view's gallery, and File ▸ Open Example… has it in the folder "extended".

## A SECOND OPINION

Run ▸ Check with Another Method simulates the network with [Replicated Simulation](help:replicatedSimulation), which draws a batch size at each arrival epoch and creates that many customers at the same instant. The Agreement view shows the exact values beside the simulation's estimates and their confidence intervals. Run ▸ Animate shows the batches arriving.

## WHAT IS NOT COVERED

- The exact formula is for one source and one single-server station. With several servers the batch queue has no closed formula, and Qnet does not offer one. With more stations the customers that leave the first one no longer arrive in batches of the law you gave. Use Replicated Simulation for these; the Method Chooser and Solve do this.
- A source that sends on only part of what it creates (its links add up to less than 1) changes the batch sizes that arrive, so the exact formula is not offered.
- Every other method reads sources as single arrivals. On a network with batch arrivals each of them refuses to run and says why, rather than answer for a different network. So do Sensitivity, Uncertainty, Capacity planning and the Transient view.
- A scenario cannot change the batch sizes yet: they are the same in every scenario of a file.

## PROBLEMS QNET POINTS OUT

- Batch probabilities that do not add up to 1.
- A batch size or a mean batch size below 1.
