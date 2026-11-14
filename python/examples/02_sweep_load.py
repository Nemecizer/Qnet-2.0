"""Sweep the arrival rate of a tandem line and see the delay grow as the load approaches 1.

    python3 02_sweep_load.py

Plots the curve when matplotlib is installed; prints it either way.
"""

import qnet

net = qnet.Network.tandem(stations=2, arrival_rate=0.5, service_rates=1.0)

# With service rate 1 at both stations, the arrival rate is the utilisation ρ.
rhos = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95]

# method="live" is the exact closed form, computed at once. Leave it out to run the solver
# Solve would choose at each point instead (slower: one process per point).
sweep = net.sweep("Src1.rate", rhos, method="live")
rho, delay = sweep.series("Mean sojourn time", "Network")

print(f"{'rho':>6}  {'mean time in the network':>26}   (tier: {sweep.tier})")
for x, y in zip(rho, delay):
    print(f"{x:6.2f}  {y:26.4f}")

# The formula for two M/M/1 queues in a row: 2 / (1 - rho).
assert all(abs(y - 2 / (1 - x)) < 1e-9 for x, y in zip(rho, delay))

try:
    import matplotlib.pyplot as plt
except ImportError:
    print("(install matplotlib to see the plot)")
else:
    plt.plot(rho, delay, marker="o")
    plt.xlabel("utilisation ρ")
    plt.ylabel("mean time in the network")
    plt.title(f"Two-station tandem · {sweep.tier}")
    plt.savefig("sweep_load.png", dpi=150)
    print("wrote sweep_load.png")
