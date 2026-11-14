"""What the documentation shows is run: every ```python block of README.md and every script of
examples/, against the built command-line tool (review finding FIX-208f: the README's examples
had been written but not executed as written).

How a README block is checked, doctest-style:

- The ```python blocks run in order in one namespace, as a reader typing them in would (a later
  block uses the `net` and `sweep` of an earlier one), in an empty working folder.
- A statement that is an expression with a trailing comment that reads as a Python value
  (`result.tier   # 'exact'`, `net.scenarios   # ['Peak hour', …]`, `… # 3.75, by 'batch_exact'`)
  must have that value; floats to 1e-6 relative. A comment that is prose is not a claim.
- A `print(...)` followed by a comment line starting with `<` must print that line.
- A fenced block with no language straight after a ```python block is what that block prints:
  its lines must be the first lines printed, up to a line that is only `…`.
- `plt.show()` needs a display and `to_pandas()` needs pandas. Where matplotlib is not installed
  a stand-in module that accepts every call takes its place, so the block's own code still runs;
  where pandas is not installed the call must fail in the way the package documents.
- `plant.bnet`, the reader's own file in the scenarios block, is the scenarios fixture of the
  Rust tests under that name (saved showing "Peak hour", with "Add a server at S2").

The examples are run as scripts (`__main__`), each in an empty folder; their own `assert`s are
their checks. One of them is slow against an unoptimised tool and is then left to the release
checklist ([`SLOW_AGAINST_A_DEBUG_BUILD`]).
"""

import ast
import contextlib
import importlib
import io
import math
import os
import re
import runpy
import shutil
import sys
import tempfile
import types
import unittest
import warnings
from pathlib import Path

from . import support
from .support import ROOT, needs_cli

README = ROOT / "python" / "README.md"
EXAMPLES = ROOT / "python" / "examples"
SCENARIOS = ROOT / "core" / "tests" / "fixtures" / "scenarios" / "feedback.bnet"


# 04_notebook.py computes the exact transient of a three-station line: 7 s with a release build
# of qnet-cli, about 2.5 minutes with the debug build `npm run check` tests against. There it is
# skipped with this sentence unless QNET_DOCS_SLOW=1; the release checklist (README) runs
# `QNET_DOCS_SLOW=1 scripts/check-python.sh`.
SLOW_AGAINST_A_DEBUG_BUILD = {"04_notebook.py"}


def tool_is_a_debug_build():
    return support.CLI is not None and Path(support.CLI).parent.name == "debug"


def fenced_blocks(text):
    """(language, first line number of the body, body) for every fenced block of a Markdown text."""
    blocks, lines, i = [], text.split("\n"), 0
    while i < len(lines):
        m = re.match(r"^```(\w*)\s*$", lines[i])
        if not m:
            i += 1
            continue
        j = i + 1
        while j < len(lines) and not lines[j].startswith("```"):
            j += 1
        blocks.append((m.group(1), i + 2, "\n".join(lines[i + 1 : j])))
        i = j + 1
    return blocks


def stated_value(comment):
    """The Python value a trailing comment states, as (True, value), or (False, None) for prose."""
    text = comment.strip()
    candidates = [text]
    for cut in (r"\s{2,}", r",\s+by\s", r"\s+\(", r":\s"):
        head = re.split(cut, text, maxsplit=1)[0]
        if head != text:
            candidates.append(head)
    for c in candidates:
        try:
            return True, ast.literal_eval(c)
        except (ValueError, SyntaxError):
            continue
    return False, None


def same(got, want):
    if isinstance(want, float) and isinstance(got, (int, float)):
        return math.isclose(got, want, rel_tol=1e-6, abs_tol=1e-9)
    if isinstance(want, (list, tuple)) and isinstance(got, (list, tuple)) and len(got) == len(want):
        return all(same(g, w) for g, w in zip(got, want))
    return got == want


class _AcceptsEverything(types.ModuleType):
    """matplotlib.pyplot where matplotlib is not installed: every call is taken and counted."""

    def __init__(self, name):
        super().__init__(name)
        self.calls = []

    def __getattr__(self, attribute):
        if attribute.startswith("__"):
            raise AttributeError(attribute)

        def call(*args, **kwargs):
            self.calls.append(attribute)

        return call


@contextlib.contextmanager
def a_plotting_library():
    """matplotlib without a window (the Agg backend), or the stand-in when it is not installed."""
    before = {k: sys.modules.get(k) for k in ("matplotlib", "matplotlib.pyplot")}
    backend = os.environ.get("MPLBACKEND")
    os.environ["MPLBACKEND"] = "Agg"
    stand_in = None
    try:
        try:
            importlib.import_module("matplotlib.pyplot")
        except ImportError:
            stand_in = _AcceptsEverything("matplotlib.pyplot")
            parent = types.ModuleType("matplotlib")
            parent.pyplot = stand_in
            sys.modules["matplotlib"], sys.modules["matplotlib.pyplot"] = parent, stand_in
        yield stand_in
    finally:
        if stand_in is not None:
            for k, v in before.items():
                if v is None:
                    sys.modules.pop(k, None)
                else:
                    sys.modules[k] = v
        if backend is None:
            os.environ.pop("MPLBACKEND", None)
        else:
            os.environ["MPLBACKEND"] = backend


@contextlib.contextmanager
def an_empty_working_folder():
    here = os.getcwd()
    with tempfile.TemporaryDirectory() as d:
        os.chdir(d)
        try:
            yield Path(d)
        finally:
            os.chdir(here)


def have(module):
    try:
        importlib.import_module(module)
        return True
    except ImportError:
        return False


class RunsABlock:
    """Runs README blocks statement by statement in one namespace and checks what they state."""

    def __init__(self, case):
        self.case = case
        self.namespace = {"__name__": "__readme__"}
        self.values_checked = 0
        self.prints_checked = 0

    def run(self, first_line, source):
        """Runs one block; returns what it printed."""
        lines = source.split("\n")
        tree = ast.parse(source)
        printed = io.StringIO()
        for k, statement in enumerate(tree.body):
            where = f"README.md:{first_line + statement.lineno - 1}"
            text = "\n".join(lines[statement.lineno - 1 : statement.end_lineno])
            last = lines[statement.end_lineno - 1]
            comment = last[statement.end_col_offset :].strip() if statement.end_col_offset <= len(last) else ""
            comment = comment[1:] if comment.startswith("#") else ""
            out = io.StringIO()
            is_expression = isinstance(statement, ast.Expr)
            code = compile(ast.Expression(statement.value) if is_expression else ast.Module([statement], []), where, "eval" if is_expression else "exec")
            value = None
            try:
                with contextlib.redirect_stdout(out):
                    value = eval(code, self.namespace) if is_expression else exec(code, self.namespace)
            except ImportError as e:
                # The one documented optional dependency of a result: pandas.
                if ".to_pandas(" in text and not have("pandas"):
                    self.case.assertIn("table() gives the same rows", str(e), where)
                else:
                    raise AssertionError(f"{where}: {text!r} raised {e!r}") from e
            except Exception as e:  # noqa: BLE001 - whatever the documentation's code raises is the finding
                raise AssertionError(f"{where}: {text!r} raised {type(e).__name__}: {e}") from e
            printed.write(out.getvalue())
            if is_expression and comment:
                stated, want = stated_value(comment)
                if stated and not (".to_pandas(" in text):
                    self.case.assertTrue(same(value, want), f"{where}: {text.strip()} is {value!r}, and the comment says {want!r}")
                    self.values_checked += 1
            # print(x) followed by "# <…": the line it prints.
            following = lines[statement.end_lineno] if statement.end_lineno < len(lines) else ""
            next_starts = tree.body[k + 1].lineno if k + 1 < len(tree.body) else len(lines) + 1
            if text.lstrip().startswith("print(") and following.startswith("# <") and next_starts > statement.end_lineno + 1:
                self.case.assertEqual(out.getvalue().rstrip("\n"), following[2:], where)
                self.prints_checked += 1
        return printed.getvalue()


@needs_cli
class TheReadme(unittest.TestCase):
    def test_the_blocks_are_found_as_written(self):
        blocks = fenced_blocks(README.read_text(encoding="utf-8"))
        self.assertEqual([lang for lang, _, _ in blocks].count("python"), 11, "a block added or removed: look at what this test covers")
        self.assertEqual(stated_value(" 4.0"), (True, 4.0))
        self.assertEqual(stated_value(" 3.75, by 'batch_exact'"), (True, 3.75))
        self.assertEqual(stated_value(" 'Peak hour'  (None for the baseline)"), (True, "Peak hour"))
        self.assertEqual(stated_value(" a list of dicts"), (False, None))
        self.assertEqual(stated_value(" 'priority_exact': exact, one station fed by Poisson sources"), (True, "priority_exact"))
        self.assertEqual(stated_value(" exact, and the pointwise stationary approximation beside it"), (False, None))

    @unittest.skipUnless(support.solvers_ready(), "the solvers are not staged (scripts/stage-solvers.sh): `net.solve()` in the README cannot run")
    def test_every_python_block_runs_as_written_and_says_what_it_shows(self):
        blocks = fenced_blocks(README.read_text(encoding="utf-8"))
        runner = RunsABlock(self)
        outputs_checked = 0
        with an_empty_working_folder() as folder, a_plotting_library() as stand_in, warnings.catch_warnings():
            # The scenarios block reads the reader's own "plant.bnet".
            shutil.copy(SCENARIOS, folder / "plant.bnet")
            warnings.simplefilter("error")  # a warning the README does not mention is a finding
            for k, (language, line, source) in enumerate(blocks):
                if language != "python":
                    continue
                printed = runner.run(line, source)
                # The block of plain text straight after it is what it prints.
                if k + 1 < len(blocks) and blocks[k + 1][0] == "" and printed:
                    want = blocks[k + 1][2].split("\n")
                    shown = want[: want.index("…")] if "…" in want else want
                    got = printed.split("\n")
                    self.assertEqual(got[: len(shown)], shown, f"README.md:{blocks[k + 1][1]}: what the block above prints")
                    outputs_checked += 1
            # "Keep it" wrote the two files it says it does, and the app's reader takes them.
            import qnet

            for name in ("tandem.bnet", "tandem-2.bnet"):
                self.assertTrue((folder / name).is_file(), name)
            self.assertEqual(qnet.Network.open(folder / "tandem-2.bnet").get("S1.servers"), 2)
            if stand_in is not None:
                self.assertEqual(stand_in.calls, ["plot", "xlabel", "ylabel", "title", "show"])
        # The runner did check things: values stated in comments, a printed line, a printed table.
        self.assertEqual(runner.values_checked, 6)
        self.assertEqual((runner.prints_checked, outputs_checked), (1, 1))


@needs_cli
class TheExamples(unittest.TestCase):
    def test_there_are_the_four_the_readme_names(self):
        self.assertEqual(sorted(p.name for p in EXAMPLES.glob("*.py")), ["01_tandem.py", "02_sweep_load.py", "03_what_would_it_take.py", "04_notebook.py"])

    @unittest.skipUnless(support.solvers_ready(), "the solvers are not staged (scripts/stage-solvers.sh): the examples call `solve`")
    def test_every_example_runs_as_a_script(self):
        for script in sorted(EXAMPLES.glob("*.py")):
            if script.name in SLOW_AGAINST_A_DEBUG_BUILD and tool_is_a_debug_build() and os.environ.get("QNET_DOCS_SLOW") != "1":
                print(f"\n(skipped {script.name}: minutes against a debug qnet-cli; QNET_DOCS_SLOW=1 runs it, as the release checklist does)", file=sys.stderr)
                continue
            with self.subTest(script.name), an_empty_working_folder(), a_plotting_library(), warnings.catch_warnings():
                warnings.simplefilter("error")
                out = io.StringIO()
                try:
                    with contextlib.redirect_stdout(out):
                        runpy.run_path(str(script), run_name="__main__")
                except SystemExit as e:
                    self.assertIn(e.code, (0, None), f"{script.name} exited with {e.code}")
                self.assertTrue(out.getvalue().strip(), f"{script.name} printed nothing")


if __name__ == "__main__":
    unittest.main()
