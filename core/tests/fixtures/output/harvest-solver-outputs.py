#!/usr/bin/env python3 -I
"""Copies the solver outputs each golden run's comparison table read into solver-outputs/.

0.90.34's wrappers left their per-method output files (BNET_*_out_<pid>.txt) and the analytical
hand-over (BNET_analytical_<pid>.txt) in the run's temp folder; golden/runs/<example>/<method>/
script.sh names them on its `awk 'FNR==1{f++}…' "file" …` line. Run this right after
scripts/make-golden-runs.sh, which moves each run's leftover BNET_* files to
~/Library/Caches/qnet/legacy-0.90.34-runs/tmp/<example>/<method>/ (or, failing that, while they are
still at the path the script names). Finite LP's wrapper deleted its
own output; that one is rebuilt by re-running the wrapper's exact solver command on the P2
corpus's fBNAlp input for the example. Each file is kept as solver-outputs/<example>/<method>/<n>.txt
(its place on the awk command line) or analytical.txt, and only when /usr/bin/awk, run on the copies,
prints a table that archive.txt contains (so a file overwritten since, e.g. by a reused pid, is
refused). Prints what it could not keep.
"""
import os, re, shutil, subprocess, sys

here = os.path.dirname(os.path.realpath(__file__))
runs = os.path.join(here, "..", "..", "..", "..", "golden", "runs")
out_root = os.path.join(here, "solver-outputs")
kept, refused = 0, []
shutil.rmtree(out_root, ignore_errors=True)  # a fresh capture of the whole corpus
golden = os.path.join(here, "..", "..", "..", "..", "golden")


def regenerate(script, missing, example, dest):
    """Finite LP's wrapper deleted its output and input; re-run its exact command on the fBNAlp
    input the P2 corpus holds for the example (the same exporter), when that is what it read."""
    m = re.search(r'\{ \{ ("[^"]*fBNAlp_solver") (.*?) > "' + re.escape(missing) + '"', script)
    if not m:
        return False
    args = m.group(2)
    inp = re.search(r'"([^"]*BNET_flp_\d+\.in)"', args)
    exported = os.path.join(golden, example, "fbnalp.in")
    if not inp or not os.path.exists(exported):
        return False
    argv = [m.group(1).strip('"')] + [a.strip('"') for a in re.findall(r'"[^"]*"|\S+', args.replace(inp.group(1), exported))]
    cwd = dest + ".cwd"
    os.makedirs(cwd, exist_ok=True)
    with open(dest, "wb") as out:
        rc = subprocess.run(argv, stdout=out, stderr=subprocess.DEVNULL, cwd=cwd).returncode
    shutil.rmtree(cwd, ignore_errors=True)
    return rc == 0

for example in sorted(os.listdir(runs)):
    edir = os.path.join(runs, example)
    if not os.path.isdir(edir):
        continue
    for method in sorted(os.listdir(edir)):
        mdir = os.path.join(edir, method)
        script_path = os.path.join(mdir, "script.sh")
        if not os.path.exists(script_path) or not os.path.exists(os.path.join(mdir, "archive.txt")):
            continue
        try:
            if b"Elapsed time: " not in open(os.path.join(mdir, "archive.txt"), "rb").read():
                continue  # the run stopped before its table
            script = open(script_path, encoding="utf-8").read()
        except OSError as e:
            refused.append(f"{example}/{method}: {e}")
            continue
        i = script.find("awk 'FNR==1{f++}")
        if i < 0:
            continue
        end = script.find("' \"", i)
        program = script[i + 5:end]
        tail = script[end + 1:]
        stop = min([x for x in (tail.find(" && "), tail.find("\n")) if x >= 0] + [len(tail)])
        files = re.findall(r'"([^"]*)"', tail[:stop])
        dest = os.path.join(out_root, example, method)
        names = ["analytical.txt" if "BNET_analytical_" in f else "%d.txt" % (k + 1) for k, f in enumerate(files)]
        tmp = dest + ".new"
        shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(tmp)
        gone = False
        for f, n in zip(files, names):
            # Where make-golden-runs.sh moved the run's leftover files, or where the wrapper wrote them.
            legacy = os.path.expanduser("~/Library/Caches/qnet/legacy-0.90.34-runs")
            found = [c for c in (os.path.join(legacy, "tmp", example, method, os.path.basename(f)), f)
                     if os.path.exists(c)]
            if found:
                shutil.copyfile(found[0], os.path.join(tmp, n))
            elif not regenerate(script, f, example, os.path.join(tmp, n)):
                gone = True
        if gone:
            shutil.rmtree(tmp)
            refused.append(f"{example}/{method}: a temp file is gone")
            continue
        # The analytical hand-over is one file per process, so the example's last run that wrote it
        # wins; Multi-class SRBM writes E[X_k] even for an infinite network. Its values do not
        # depend on the variable name, so give it the one this program reads.
        var = "Q" if "E\\[Q_" in program else "X"
        if "analytical.txt" in names:
            a = os.path.join(tmp, "analytical.txt")
            text = open(a, encoding="utf-8").read()
            open(a, "w", encoding="utf-8").write(re.sub(r"^E\[[XQ]_", "E[" + var + "_", text, flags=re.M))
        table = subprocess.run(["/usr/bin/awk", program] + [os.path.join(tmp, n) for n in names],
                               capture_output=True, check=True).stdout
        archive = open(os.path.join(mdir, "archive.txt"), "rb").read()
        if table and table in archive:
            shutil.rmtree(dest, ignore_errors=True)
            os.rename(tmp, dest)
            kept += 1
        else:
            shutil.rmtree(tmp)
            refused.append(f"{example}/{method}: the copies do not reproduce archive.txt")
print(f"kept {kept} runs' outputs")
for r in refused:
    print("REFUSED", r)
