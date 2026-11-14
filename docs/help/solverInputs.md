# SOLVER INPUT FILES

## WHAT THEY ARE

Every method in Qnet is a separate command-line program that reads a small text file describing the network. The Run menu writes those files to a temporary folder and runs the program for you; File ▸ Export writes the same files somewhere you choose, so a solver can be run by hand, scripted, or handed to a colleague without Qnet. The command-line tool qnet-cli writes the whole set:

```
qnet-cli export-all network.bnet /path/to/folder
```

## WHICH FILE FEEDS WHICH SOLVER

```
qna.qna       QNA, RQNA, SBD          bna_qna, bna_rqna, bna_sbd
cmp_sm.in     Spectral (infinite)     bnet
cmp_sim.sim   Simulation (infinite)   jackson_sim
sm.in         Spectral (finite)       srbm_solver
fm.in         Finite Element          bna_fm_gauss, bna_fm_cbc
lp.in         Finite-Buffer LP        fBNAlp_solver
sim.txt       Simulation (finite)     fBNAsim
network.bnet  Linear Program, SRBM    srbm_lp, rbm_mlmc
              MLMC, Multi-Class       (read the .bnet directly)
```

## THE EXPORT COMMANDS

- Export ▸ SRBM Solver Input (.in)… — the drift, covariance and reflection data for the spectral solvers. On a finite-buffer network the sheet also asks which blocking convention the file should encode.
- Export ▸ QNA Input (.qna)… — the rates, squared coefficients of variation and routing matrix for the QNA family.
- Export ▸ Finite Simulator Input (fBNAsim)… — the network description for the finite-buffer simulator.
- Export ▸ All Solver Inputs to Folder… (⌘E) — every file in the table above, into one folder, with the same blocking choice for the three finite-buffer SRBM files.

## BLOCKING CONVENTION

Only sm.in, fm.in and lp.in depend on it; the QNA and simulator inputs do not. The SRBM solves a manufacturing-blocking model; the Loss and BAS corrections adjust its primitives so it matches a loss network or blocking-after-service with external loss. The same choice appears on the command line as --loss-fix / --bas-fix, so a folder exported from the GUI holds exactly what qnet-cli would have produced. SRBM in a Hypercube explains the three conventions and why the simulator can disagree with the SRBM methods when they differ.

## RUNNING A SOLVER BY HAND

Every solver takes -c for compact, machine-readable output: an algorithm banner, then one line per station of the form rho\_N = v, Gamma\_N = v, sojourn\_N = v and E\[Q\_N\] (infinite) or E\[X\_N\] (finite). Simulators append a tab and the 95 % half-width.

```
infinite/BNAqna/bna_qna  folder/qna.qna -c
infinite/BNAsm/bnet   -c folder/cmp_sm.in
infinite/BNAsim/jackson_sim folder/cmp_sim.sim -c -n 5 -r 2000
```

The paths are relative to the folder that holds the solver programs; inside Qnet.app that is Contents/Resources/bin.
