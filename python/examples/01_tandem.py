"""Build a two-station tandem line, solve it, and save it for the app.

    python3 01_tandem.py
"""

import qnet

# Jobs arrive at rate 0.8, are served at S1 (rate 1.0), then at S2 (rate 1.6), and leave.
net = qnet.Network.tandem(stations=2, arrival_rate=0.8, service_rates=[1.0, 1.6])
print(net)

# What Qnet makes of it before anything is run: utilisation from the traffic equations.
for station in net.describe()["stations"]:
    print(f"  {station['name']}: utilisation {station['utilisation']:.2f}")

# The methods Qnet offers for this network, best first; the starred one is what solve() runs.
for m in net.methods():
    if m.applicable and m.label:
        print(f"  {'*' if m.chosen else ' '} {m.label:16} {m.tier:14} {m.name}")

# Solve: the method the app's Solve button would choose.
result = net.solve()
print(result)
print("mean number at S1:", result.value("Mean number in system", "S1"), f"({result.tier})")

# A file the app opens (File > Open).
print("saved", net.save("tandem.bnet"))
