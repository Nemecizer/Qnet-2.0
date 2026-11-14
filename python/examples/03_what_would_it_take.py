"""A clinic with a feedback loop: where is the bottleneck, what would it take to cut the delay,
and how sure is the answer when the arrival rate is only roughly known?

    python3 03_what_would_it_take.py
"""

import qnet

net = qnet.Network(name="clinic")
arrivals = net.add_source("Patients", rate=4.0)          # per hour
net.add_buffer("WaitTriage")
net.add_station("Triage", rate=6.0)
net.add_buffer("WaitDoctor")
net.add_station("Doctor", rate=2.5, servers=3)
net.add_sink("Home")
net.link(arrivals, "WaitTriage").link("WaitTriage", "Triage")
net.link("Triage", "WaitDoctor").link("WaitDoctor", "Doctor")
net.link("Doctor", "Home", probability=0.8)
net.link("Doctor", "WaitDoctor", probability=0.2)       # one visit in five needs a second look

live = net.live()
print(live)
print("bottleneck:", ", ".join(live.bottlenecks))

# How the mean time in the clinic responds to each parameter, and what each one alone would
# have to be to cut that time by a quarter.
print(net.sensitivity(measure="sojourn", target_change=-0.25))

# The cheapest staffing that keeps the mean time in the clinic under 45 minutes, when a doctor
# costs five times what a triage nurse does.
plan = net.capacity(sojourn=0.75, stations=[{"station": "Doctor", "cost": 5}, {"station": "Triage", "cost": 1}])
print(plan)
print("proof:", plan.proof, "| mean time now", round(plan.mean_delay_now, 3), "→", round(plan.mean_delay, 3))

# "Four an hour, give or take 10 %": the answer's 95 % range, each draw solved exactly.
unsure = net.uncertainty({"Patients.rate": 0.10}, measure="sojourn", seed=1)
print(unsure)
