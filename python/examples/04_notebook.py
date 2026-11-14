# %% [markdown]
# # Qnet in a notebook
#
# This file is a notebook in the "percent" format: VS Code, PyCharm, Spyder and Jupytext open it
# as cells (`# %%`), and `python3 04_notebook.py` runs it from top to bottom as a script.
# It needs only the `qnet` package and Qnet itself; the plots appear when matplotlib is installed.

# %%
import qnet

print(qnet.cli_version(), "at", qnet.find_cli())

# %% [markdown]
# ## A network
# Three machines in a row. The middle one is the slow one.

# %%
line = qnet.Network.tandem(stations=3, arrival_rate=0.7, service_rates=[1.2, 0.9, 1.5], name="line")
line

# %%
line.live()  # in a notebook the result shows as a table

# %% [markdown]
# ## Which method?
# `methods()` is the app's Method Chooser; `solve()` runs the starred row.

# %%
for m in line.methods():
    print("*" if m.chosen else " ", (m.label or "-").ljust(16), m.suitability.ljust(12), m.reason)

# %%
result = line.solve()
result

# %% [markdown]
# ## What if the middle machine had a second server?

# %%
sweep = line.sweep("S2.servers", [1, 2, 3], method="live")
servers, number = sweep.series("Mean number in system", "S2")
for c, n in zip(servers, number):
    print(f"{int(c)} server(s): {n:.3f} jobs at S2 on average")

# %% [markdown]
# ## Starting empty: how long until the line settles?

# %%
t = line.transient()
print("settling times (within 5 % of steady state):", t.settling)

try:
    import matplotlib.pyplot as plt
except ImportError:
    print("(install matplotlib to see the curves)")
else:
    for name in t.station_names:
        plt.plot(t.times, t.exact[name], label=name)
    plt.xlabel("time")
    plt.ylabel("mean number at the station")
    plt.legend()
    plt.title(f"From empty · {t.tier}")
    plt.savefig("transient.png", dpi=150)
    print("wrote transient.png")

# %% [markdown]
# ## As a DataFrame
# Every result has `table()` (plain dicts) and, with pandas installed, `to_pandas()`.

# %%
try:
    frame = sweep.to_pandas()
except ImportError as e:
    print(e)
else:
    print(frame[frame.metric == "Mean sojourn time"].pivot(index="S2.servers", columns="station", values="value"))
