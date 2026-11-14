# Qnet 2.1

Qnet is a Mac app for drawing queueing networks and finding out how they behave: how busy each station is, how long the queues grow, how long customers wait, and how sure each answer is. You draw sources, buffers, stations and sinks on a canvas, set arrival and service laws, and press Solve. Qnet picks a suitable method, runs it, and shows the answer on the canvas, in tables and in charts. A second, independent method can check it, and Qnet says how well the two agree.

It is built for teaching and for research. Students get a guided tour, live results while they draw, and problems marked where they are. Researchers get some twenty exact, approximate, diffusion, bound and simulation methods side by side, sweeps and sensitivities, and a scriptable command line.

## Install

Download the newest release from the [Releases page](https://github.com/Nemecizer/Qnet-2.0/releases/latest): the installer (`Qnet-<version>-arm64.pkg`) or the app alone (`Qnet-<version>-arm64.zip`). Both are signed and notarized by Apple.

- An Apple Silicon Mac with macOS 14 or later.
- Nothing else to install: the solvers, their libraries, and a private Python with NumPy are inside the app.
- Qnet keeps itself up to date from this repository's releases; Settings ▸ General ▸ Updates turns the daily check off.

## Getting started

1. Open Qnet. The Welcome view offers **Start with a Tandem Line**, a gallery of more than fifty example networks, and **Take the Tour**, a two-minute walk through building and solving a first model.
2. Draw a network with the tools (Source, Buffer, Station, Sink, Link) or open an example. Select a node to edit its parameters in the Inspector: rates and distributions, servers, buffer sizes, routing.
3. Press **Solve** (⌘↩). Utilisation and queue lengths appear beside each station, with the bottleneck marked. The Results pane shows the full table.
4. Press **Check with Another Method**. The Agreement view lines up both answers and says whether they agree (within 2 %), are close (within 10 %) or disagree, and which one is the reference.
5. Ask what changes the answer: **What-If Sweep** varies one parameter over a range; **Sensitivity** ranks every parameter by its effect; **Plan Capacity** finds the cheapest servers that meet a target.

Help ▸ Qnet Help has an article for every method and feature, most with an example that opens and runs in one click.

## What Qnet models

- **Open networks** with any number of stations, single- or multi-class customers, probabilistic routing and feedback, one or several servers per station, and infinite or finite buffers.
- **Closed networks**, where a fixed population circulates.
- **Arrival and service laws**: Poisson arrivals, and exponential, Erlang, gamma, lognormal, Weibull, Pareto, uniform and deterministic times. A law can be fitted to measured data with Fit from Data… in the Inspector.
- **Priorities** at a station (non-preemptive or preemptive-resume), **batch arrivals**, and **arrival rates that vary through the day**.

When a method cannot handle part of a model, it says so in a sentence rather than ignoring it.

## Methods

Every answer carries the kind of evidence behind it.

| Kind | Methods |
|---|---|
| **Exact** | Open and closed product form (Jackson, BCMP, Buzen and MVA), matrix-analytic QBD, sparse and adaptive truncated CTMC, priority and batch-arrival queues |
| **Simulation** | Monte Carlo, regenerative Monte Carlo, replicated simulation, each with confidence intervals |
| **Approximation** | Whitt's QNA, Whitt–You RQNA, finite-buffer decomposition |
| **Diffusion model** | SRBM in the orthant and hypercube, multi-class SRBM, spectral and finite-element methods, SBD, SRBM MLMC |
| **Bound** | Linear programs, BAR moment bounds, adaptive low-rank BAR |

Run ▸ Choose a Method… explains which methods apply to the network on screen and why.

## Analyses

- **Results on the canvas**, **charts** (exportable as PDF, PNG or SVG) and the **Agreement view**.
- **Live results** while drawing: utilisation always, and exact queue lengths wherever a closed form exists.
- **What-If Sweeps**, **Sensitivity** (with "what would it take to cut delay by 10 %"), **Capacity planning**, **Uncertainty** in the inputs (the chance of overload, and which input matters most), and **Transient** behaviour over time (how long the network takes to settle, or what a surge does).
- **Scenarios**: named variants of one network kept in the same file and compared side by side.
- **Animation** of one random run, to watch customers queue and move.

## The assistant

The AI pane can build networks from a description, run methods, and explain results ("why is S2 the bottleneck?", "how sure is this?", "draft a methods paragraph"). Every number in its reply is checked against the run or computation it cites, and a number it cannot source is marked unverified. It works with Anthropic's Claude, OpenAI, or a local model through Ollama or LM Studio; set it up in Settings ▸ AI Assistant. Only the network and its results are sent, and only to the provider you choose.

## Scripting

- `qnet-cli`, inside the app at `Qnet.app/Contents/MacOS/qnet-cli`, describes, solves and analyses `.bnet` files and answers in JSON ([docs/CLI.md](docs/CLI.md)).
- The `qnet` Python package builds, solves and sweeps networks from a script or notebook, using your own Python 3.9 or later ([python/README.md](python/README.md)). The app carries a copy in `Qnet.app/Contents/Resources/scripting`.

## Files

Networks are `.bnet` files (JSON) and open from Finder. Scenarios, closed populations, priorities, batch sizes and rate profiles are written only when a network uses them, so other networks are saved exactly as earlier versions of Qnet wrote them.

## Accessibility

Qnet can be used without a pointer: Tab moves through the canvas, and View ▸ Canvas Outline (⌥⌘O) lists every node and link to read and edit. View ▸ Appearance sets theme, contrast, motion and text size. [docs/ACCESSIBILITY.md](docs/ACCESSIBILITY.md) says what is supported and what has been tested.

## Building from source

Qnet is a Tauri 2 app: the interface is React with TypeScript, the model and analyses are Rust, and the solvers are C and Python. [docs/DEVELOPING.md](docs/DEVELOPING.md) covers the layout, the checks, and how to build, sign and release.

## Licence

Qnet is MIT-licensed ([LICENSE](LICENSE)). The app bundles third-party libraries under their own licences, among them SuiteSparse components under GPL-2.0-or-later and LGPL-2.1-or-later; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and [ThirdPartyLicenses/](ThirdPartyLicenses/).
