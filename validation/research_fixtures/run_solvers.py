#!/usr/bin/env python3
"""Runs every SRBM solver in the tree on every exact fixture it accepts.

Each fixture's stationary means are known exactly (oracle_check.py verifies
them without running a solver), so this measures solver error against the
truth rather than against another solver. The settings are the GUI defaults
unless a comment says otherwise, so the numbers describe what a user gets.

    python3 run_solvers.py                 # run, print the table, apply ledger.json
    python3 run_solvers.py --only E07      # fixtures whose id starts with E07
    python3 run_solvers.py --solver BNAlp  # one solver
    python3 run_solvers.py --write-ledger  # record the current results as the baseline

ledger.json records, for each fixture/solver cell, the gate it must meet:
  rtol         max relative error of the means <= tol (Plans.md T1 is 1e-3)
  deviation    a measured error that is known and explained; the cell fails
               if the error grows past `max_rel_err` (it is a regression
               guard, not an acceptance), and says so if it falls below 1e-3
  statistical  Monte Carlo: every |estimate - exact| <= z * SE
  interval     bounds: every exact mean lies inside the reported interval
A cell absent from the ledger is reported but cannot fail the run.

Exit status: 0 when every ledger cell passes, 1 otherwise, 2 on usage errors.
"""

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
# Qnet 2.0: a solver is looked for first where it ships (QNET_SOLVER_BIN: the stage's or a
# bundle's Contents/Resources/bin) and then in the build copy outside Dropbox
# (QNET_SOLVER_BUILD), which also holds the solvers that are not shipped (infinite/BNAfm).
# 0.90.34 ran everything from the source tree it was built in.
_CACHE = os.path.join(os.path.expanduser("~"), "Library", "Caches", "qnet", "solvers")
ROOT = os.path.abspath(os.environ.get("QNET_SOLVER_BUILD") or os.path.join(_CACHE, "build"))
SHIPPED = os.path.abspath(os.environ.get("QNET_SOLVER_BIN") or os.path.join(_CACHE, "stage", "Resources", "bin"))
FIXTURES = os.path.join(HERE, "fixtures")
LEDGER = os.path.join(HERE, "ledger.json")
WORK = os.path.join(tempfile.gettempdir(), "qnet-research-fixtures")
TIMEOUT = 600
T1 = 1e-3

MEAN_LINE = re.compile(r"^E\[[QXZ]_0*(\d+)\]\s*=\s*(\S+)", re.M)


class SolverError(Exception):
    pass


def fmt_row(values):
    return " ".join(repr(float(v)) for v in values)


def run(cmd, env=None, cwd=None, timeout=TIMEOUT):
    """Runs a solver in its own process group, so a timeout also kills the
    children it spawned (BNAfm runs fBNAfm through a shell)."""
    start = time.monotonic()
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            env=env, cwd=cwd, stdin=subprocess.DEVNULL, start_new_session=True)
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.communicate()
        raise SolverError("timed out after %d s" % timeout)
    seconds = time.monotonic() - start
    if proc.returncode != 0:
        tail = (stderr.strip() or stdout.strip()).splitlines()[-3:]
        raise SolverError("exit %d: %s" % (proc.returncode, " | ".join(tail)))
    return stdout, seconds


def parse_means(text, d):
    found = {int(i): float(v) for i, v in MEAN_LINE.findall(text)}
    if sorted(found) != list(range(1, d + 1)):
        raise SolverError("could not parse E[Z_i] for i = 1..%d" % d)
    return [found[i] for i in range(1, d + 1)]


def locate(rel):
    for root in (SHIPPED, ROOT):
        path = os.path.join(root, rel)
        if os.path.exists(path):
            return path
    return os.path.join(ROOT, rel)


def binary(rel):
    path = locate(rel)
    if not os.access(path, os.X_OK):
        raise SolverError("not built: %s" % rel)
    return path


# --- orthant solvers ----------------------------------------------------------

def bnasm(fx, work):
    m = fx["model"]
    d = m["dimension"]
    # GUI default degree 8, lowered where the GUI's 2 GB dense-basis limit
    # would refuse it (d = 20 allows 4; 3 keeps the run under a minute).
    degree = 8 if d <= 5 else 3
    path = os.path.join(work, "bnasm.in")
    with open(path, "w") as f:
        f.write("%d\n%s\n" % (d, fmt_row(m["drift"])))
        f.writelines(fmt_row(r) + "\n" for r in m["covariance"])
        f.writelines(fmt_row(r) + "\n" for r in m["reflection"])
        f.write("%d\n" % degree)
    out, sec = run([binary("infinite/BNAsm/bnet"), "-c", path], cwd=work)
    return {"means": parse_means(out, d), "seconds": sec, "settings": "degree %d" % degree}


def bnafm(fx, work):
    m = fx["model"]
    d = m["dimension"]
    if not 2 <= d <= 8:
        raise SolverError("skip: BNAfm takes 2 <= K <= 8")
    path = os.path.join(work, "bnafm.in")
    with open(path, "w") as f:
        f.write("%d\n%s\n" % (d, fmt_row(m["drift"])))
        f.writelines(fmt_row(r) + "\n" for r in m["covariance"])
        f.writelines(fmt_row(r) + "\n" for r in m["reflection"])
        f.write(" ".join(["20"] * d) + "\n")      # the solver's own default mesh
    env = dict(os.environ, FBNAFM_BIN=binary("finite/fBNAfm/bna_fm_gauss"))
    # BNAfm grows its box for 12 rounds whatever happens, so a case it cannot
    # do takes long; two minutes is far beyond any case it can.
    out, sec = run([binary("infinite/BNAfm/bna_fm"), path, "-c"], env=env, cwd=work, timeout=120)
    return {"means": parse_means(out, d), "seconds": sec, "settings": "mesh 20"}


BNALP_GRID = {1: (100, 6), 2: (100, 6), 3: (25, 5), 4: (12, 4), 5: (10, 3),
              6: (6, 3), 7: (5, 3), 8: (4, 3), 9: (3, 3), 10: (3, 3)}


def bnalp(fx, work):
    m = fx["model"]
    d = m["dimension"]
    if d > 10:
        raise SolverError("skip: BNAlp takes d <= 10")
    n, basis = BNALP_GRID[d]                  # BNASRBMExporter.recommendedBNAlpGrid
    path = os.path.join(work, "bnalp.in")
    with open(path, "w") as f:
        f.write("dimension %d\ngrid_n %d\nbasis_m %d\ngrid_type exponential\n" % (d, n, basis))
        f.write("drift\n  %s\ncovariance\n" % fmt_row(m["drift"]))
        f.writelines("  " + fmt_row(r) + "\n" for r in m["covariance"])
        f.write("reflection\n")
        f.writelines("  " + fmt_row(r) + "\n" for r in m["reflection"])
        f.write("grid_spacing\n  %s\n" % " ".join(["0.0"] * d))
        f.write("tightness_bounds\n  %s\n" % " ".join(["100000"] * (2 * d + 1)))
    out, sec = run([binary("infinite/BNAlp/srbm_lp"), "--input", path,
                    "--output", os.path.join(work, "bnalp_out"), "--solver", "highs", "-c"], cwd=work)
    return {"means": parse_means(out, d), "seconds": sec, "settings": "grid_n %d, basis_m %d" % (n, basis)}


def bnamc(fx, work):
    m = fx["model"]
    d = m["dimension"]
    path = os.path.join(work, "bnamc.in")
    with open(path, "w") as f:
        f.write("%d\n%s\n" % (d, fmt_row(m["drift"])))
        f.writelines(fmt_row(r) + "\n" for r in m["covariance"])
        f.writelines(fmt_row(r) + "\n" for r in m["reflection"])
    # GUI defaults: step factor 0.05, target RMSE 0.01; a fixed seed makes
    # the run reproducible.
    # Without -c the report carries the per-component SE table.
    out, sec = run([binary("infinite/BNAmc/rbm_mlmc"), path, "0.05", "0.01", "--seed", "20261021"], cwd=work)
    se = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 4 and parts[0].isdigit():
            try:
                se[int(parts[0])] = float(parts[2])
            except ValueError:
                pass
    means = parse_means(out, d)
    keys = sorted(se)
    base = 0 if keys and keys[0] == 0 else 1     # the table may index from 0 or 1
    ses = [se.get(i + base) for i in range(d)]
    if any(s is None for s in ses):
        raise SolverError("could not parse the standard-error table")
    return {"means": means, "se": ses, "seconds": sec, "settings": "gamma 0.05, eps 0.01, seed 20261021"}


def python_with(module):
    for exe in (sys.executable, "/usr/bin/python3"):
        if exe and os.access(exe, os.X_OK):
            ok = subprocess.run([exe, "-c", "import %s" % module], capture_output=True).returncode == 0
            if ok:
                return exe
    return None


def bnabb(fx, work):
    m = fx["model"]
    d = m["dimension"]
    doc = {"schema_version": 1, "model_type": "orthant_srbm_bar_bounds", "name": fx["id"],
           "drift": m["drift"], "covariance": m["covariance"], "reflection": m["reflection"],
           "relaxation": {"order": 2}}
    path = os.path.join(work, "bnabb.json")
    with open(path, "w") as f:
        json.dump(doc, f)
    # Numerical bounds for a non-product-form SRBM need CVXPY, which only
    # some interpreters have; without it only exact cases give an answer.
    exe = python_with("cvxpy") or sys.executable
    backend = "auto" if exe != sys.executable or python_with("cvxpy") == sys.executable else "none"
    out, sec = run([exe, locate("infinite/BNAbb/solver.py"), path, "--json", "--backend", backend], cwd=work)
    data = json.loads(out)
    method = data.get("method", {})
    if "means" in method:
        return {"means": method["means"], "seconds": sec, "settings": "exact path (%s)" % method.get("kind")}
    intervals = []
    for i in range(1, d + 1):
        t = method.get("targets", {}).get("mean_x%d" % i, {})
        lo = t.get("lower", {}).get("numerical_value", t.get("lower_bound"))
        hi = t.get("upper", {}).get("numerical_value", t.get("upper_bound"))
        if lo is None or hi is None:
            if backend == "none":
                raise SolverError("optional: no CVXPY interpreter, so no numerical bounds")
            raise SolverError("no bound for mean_x%d (backend %s)" % (i, backend))
        intervals.append((lo, hi))
    return {"intervals": intervals, "seconds": sec, "settings": "order-2 bounds, backend %s" % backend}


def bnaalr(fx, work):
    m = fx["model"]
    d = m["dimension"]
    if d > 32:
        raise SolverError("skip: BNAalr takes d <= 32")
    doc = {"schema_version": 1, "drift": m["drift"], "covariance": m["covariance"],
           "reflection": m["reflection"]}
    path = os.path.join(work, "bnaalr.json")
    with open(path, "w") as f:
        json.dump(doc, f)
    out, sec = run([sys.executable, locate("infinite/BNAalr/low_rank_bar.py"), path, "--json"], cwd=work)
    data = json.loads(out)
    note = "converged" if data.get("converged") else "not converged"
    return {"means": data["stationary_means"], "seconds": sec, "settings": "defaults, " + note}


# --- box solvers ----------------------------------------------------------------

def box_columns(m):
    """(lower, upper) as lists of column vectors."""
    d = m["dimension"]
    lower = [[m["reflection"][i][j] for i in range(d)] for j in range(d)]
    upper = [[m["upper_reflection"][i][j] for i in range(d)] for j in range(d)]
    return lower, upper


def fbnasm(fx, work):
    m = fx["model"]
    d = m["dimension"]
    lower, upper = box_columns(m)
    degree = 8                                   # GUI default
    path = os.path.join(work, "fbnasm.in")
    with open(path, "w") as f:
        f.write("%d\n%s\n" % (d, fmt_row(m["drift"])))
        f.writelines(fmt_row(r) + "\n" for r in m["covariance"])
        for i in range(d):                       # interleaved: lower_1, upper_1, lower_2, ...
            f.write(fmt_row([x for j in range(d) for x in (lower[j][i], upper[j][i])]) + "\n")
        f.write(fmt_row(m["upper_bounds"]) + "\n%d\n" % degree)
    out, sec = run([binary("finite/fBNAsm/srbm_solver"), path, "-c"], cwd=work)
    return {"means": parse_means(out, d), "seconds": sec, "settings": "degree %d" % degree}


def fbnafm(fx, work):
    m = fx["model"]
    d = m["dimension"]
    if d > 8:
        raise SolverError("skip: fBNAfm takes K <= 8")
    lower, upper = box_columns(m)
    mesh = 10                                    # GUI default
    path = os.path.join(work, "fbnafm.in")
    with open(path, "w") as f:
        f.write("%d\n%s\n" % (d, fmt_row(m["drift"])))
        f.writelines(fmt_row(r) + "\n" for r in m["covariance"])
        for i in range(d):                       # grouped: lower_1..lower_K, upper_1..upper_K
            f.write(fmt_row([lower[j][i] for j in range(d)] + [upper[j][i] for j in range(d)]) + "\n")
        f.write(fmt_row(m["upper_bounds"]) + "\n" + " ".join([str(mesh)] * d) + "\n")
    out, sec = run([binary("finite/fBNAfm/bna_fm_gauss"), path, "-c"], cwd=work)
    return {"means": parse_means(out, d), "seconds": sec, "settings": "mesh %d" % mesh}


FBNALP_GRID = {1: (64, 8), 2: (20, 6), 3: (12, 4), 4: (8, 3)}


def fbnalp(fx, work):
    m = fx["model"]
    d = m["dimension"]
    if d > 10:
        raise SolverError("skip: fBNAlp takes d <= 10")
    n, basis = FBNALP_GRID.get(d, (6, 3))        # SRBMExporter.recommendedFiniteLPGrid
    lower, upper = box_columns(m)
    path = os.path.join(work, "fbnalp.in")
    with open(path, "w") as f:
        f.write("dimension %d\ngrid_n %d\nbasis_m %d\ngrid_type uniform\nsolver highs\n" % (d, n, basis))
        f.write("drift\n  %s\ncovariance\n" % fmt_row(m["drift"]))
        f.writelines("  " + fmt_row(r) + "\n" for r in m["covariance"])
        f.write("reflection_form interleaved\nreflection\n")
        for i in range(d):
            f.write("  " + fmt_row([x for j in range(d) for x in (lower[j][i], upper[j][i])]) + "\n")
        f.write("upper_bounds\n  %s\n" % fmt_row(m["upper_bounds"]))
    out, sec = run([binary("finite/fBNAlp/fBNAlp_solver"), "--input", path, "--solver", "highs",
                    "--output", os.path.join(work, "fbnalp_out"), "-c"], cwd=work)
    return {"means": parse_means(out, d), "seconds": sec, "settings": "grid_n %d, basis_m %d" % (n, basis)}


SOLVERS = [
    ("BNAsm", "orthant", bnasm), ("BNAfm", "orthant", bnafm), ("BNAlp", "orthant", bnalp),
    ("BNAmc", "orthant", bnamc), ("BNAbb", "orthant", bnabb), ("BNAalr", "orthant", bnaalr),
    ("fBNAsm", "box", fbnasm), ("fBNAfm", "box", fbnafm), ("fBNAlp", "box", fbnalp),
]


# --- comparison -----------------------------------------------------------------

def assess(result, exact):
    """Fills in max relative error (and z or interval coverage) in place."""
    if "means" in result:
        errs = [abs(g - e) / abs(e) for g, e in zip(result["means"], exact)]
        result["max_rel_err"] = max(errs)
        if "se" in result:
            result["max_z"] = max(abs(g - e) / s if s > 0 else float("inf")
                                  for g, e, s in zip(result["means"], exact, result["se"]))
    if "intervals" in result:
        result["covered"] = all(lo - 1e-9 <= e <= hi + 1e-9 for (lo, hi), e in zip(result["intervals"], exact))
        result["max_rel_width"] = max((hi - lo) / e for (lo, hi), e in zip(result["intervals"], exact))


def judge(result, gate):
    """(ok, text) for one cell against its ledger gate."""
    if gate is None:
        if "error" in result:
            return True, "no gate; solver failed: " + result["error"]
        if "intervals" in result:
            return True, "no gate; exact %s bounds" % ("inside" if result["covered"] else "OUTSIDE")
        text = "no gate; rel err %.2e" % result["max_rel_err"]
        if "max_z" in result:
            text += ", |err|/SE %.2f" % result["max_z"]
        return True, text
    if "error" in result:
        if gate.get("gate") == "skip":
            return True, "skipped by ledger"
        if result["error"].startswith("optional:"):
            return True, "unavailable (" + result["error"] + ")"
        return False, "solver failed: " + result["error"]
    kind = gate["gate"]
    if kind == "rtol":
        ok = result.get("max_rel_err", float("inf")) <= gate["tol"]
        return ok, "rel err %.2e %s %.0e" % (result.get("max_rel_err", float("nan")), "<=" if ok else ">", gate["tol"])
    if kind == "deviation":
        err = result.get("max_rel_err", float("inf"))
        ok = err <= gate["max_rel_err"]
        text = "known deviation %.2e (guard %.2e)" % (err, gate["max_rel_err"])
        if err <= T1:
            text += "; now within T1, promote it to rtol"
        return ok, text
    if kind == "statistical":
        ok = result.get("max_z", float("inf")) <= gate["z"]
        return ok, "max |err|/SE %.2f %s %g" % (result.get("max_z", float("nan")), "<=" if ok else ">", gate["z"])
    if kind == "interval":
        ok = bool(result.get("covered"))
        return ok, "exact inside bounds" if ok else "exact OUTSIDE bounds"
    if kind == "skip":
        return True, "skipped by ledger"
    return False, "unknown gate %r" % kind


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", help="fixture id prefix")
    parser.add_argument("--solver", help="solver name")
    parser.add_argument("--write-ledger", action="store_true",
                        help="write ledger.json from this run (deviation cells get a placeholder reason)")
    parser.add_argument("--json", help="also write the raw results to this file")
    parser.add_argument("--all", action="store_true",
                        help="also run cells the ledger marks skip (they are slow or cannot run)")
    args = parser.parse_args()

    ledger = {}
    if os.path.exists(LEDGER):
        with open(LEDGER, encoding="utf-8") as f:
            ledger = json.load(f)["cells"]

    fixtures = []
    for name in sorted(os.listdir(FIXTURES)):
        if name.endswith(".json") and (not args.only or name.startswith(args.only)):
            with open(os.path.join(FIXTURES, name), encoding="utf-8") as f:
                fixtures.append(json.load(f))
    solvers = [s for s in SOLVERS if not args.solver or s[0] == args.solver]
    if not fixtures or not solvers:
        print("nothing selected", file=sys.stderr)
        return 2

    os.makedirs(WORK, exist_ok=True)
    results, failed = {}, []
    for fx in fixtures:
        exact = fx["expected"]["mean"]
        for name, domain, fn in solvers:
            if fx["model"]["domain"] != domain:
                continue
            key = "%s/%s" % (fx["id"], name)
            gate = ledger.get(key)
            if gate and gate.get("gate") == "skip" and not args.all:
                print("%-4s %-8s %-7s %6s   skipped: %s" % ("ok", fx["id"], name, "", gate.get("reason", "")[:70]))
                continue
            work = os.path.join(WORK, fx["id"], name)
            shutil.rmtree(work, ignore_errors=True)
            os.makedirs(work)
            try:
                result = fn(fx, work)
                assess(result, exact)
            except SolverError as e:
                result = {"error": str(e)}
            results[key] = result
            ok, text = judge(result, ledger.get(key))
            if not ok:
                failed.append(key)
            shown = result.get("means") or result.get("intervals") or []
            values = " ".join(("%.4g" % v) if not isinstance(v, (list, tuple)) else "[%.4g, %.4g]" % tuple(v)
                              for v in shown[:6]) + (" …" if len(shown) > 6 else "")
            print("%-4s %-8s %-7s %6.1fs  %-62s %s" % ("ok" if ok else "FAIL", fx["id"], name,
                                                      result.get("seconds", 0.0), text[:62], values))
            sys.stdout.flush()

    if args.json:
        with open(args.json, "w") as f:
            json.dump(results, f, indent=1)

    if args.write_ledger:
        cells = {}
        for key, r in results.items():
            if "error" in r:
                cells[key] = {"gate": "skip", "reason": r["error"]}
            elif "intervals" in r:
                cells[key] = {"gate": "interval"}
            elif "se" in r:
                cells[key] = {"gate": "statistical", "z": 4, "observed_max_z": round(r["max_z"], 3),
                              "observed_max_rel_err": float("%.3g" % r["max_rel_err"])}
            elif r["max_rel_err"] <= T1:
                cells[key] = {"gate": "rtol", "tol": T1, "observed": float("%.3g" % r["max_rel_err"])}
            else:
                cells[key] = {"gate": "deviation",
                              "max_rel_err": float("%.3g" % (r["max_rel_err"] * 1.25 + 1e-4)),
                              "observed": float("%.3g" % r["max_rel_err"]),
                              "settings": r.get("settings", ""),
                              "reason": "TODO"}
        with open(LEDGER, "w", encoding="utf-8") as f:
            json.dump({"note": "Gates for run_solvers.py; see its docstring.", "cells": cells}, f, indent=1)
            f.write("\n")
        print("wrote", LEDGER)

    if failed:
        print("\n%d cell(s) failed their ledger gate: %s" % (len(failed), ", ".join(failed)))
        return 1
    print("\nAll ledger gates passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
