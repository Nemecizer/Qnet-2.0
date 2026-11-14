"""What the package does to the machine around it: nothing written inside a signed Qnet.app, and
no process left running when a call is timed out or interrupted. These need no `qnet-cli`."""

import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

import qnet
from qnet import _cli

PACKAGE = Path(qnet.__file__).resolve().parent


def _import_from(folder, env_extra=None):
    """Imports qnet in a fresh Python whose path starts with `folder`, bytecode writing left on."""
    env = {k: v for k, v in os.environ.items() if k not in ("PYTHONDONTWRITEBYTECODE", "PYTHONPYCACHEPREFIX")}
    env["PYTHONPATH"] = str(folder)
    env.update(env_extra or {})
    code = "import sys, qnet, qnet.network, qnet.results; print(qnet.__file__); print(sys.dont_write_bytecode)"
    done = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, cwd=str(folder))
    return done


class NothingIsWrittenInsideTheApp(unittest.TestCase):
    def _copy(self, d, *parts):
        folder = Path(d).joinpath(*parts)
        folder.mkdir(parents=True)
        shutil.copytree(PACKAGE, folder / "qnet", ignore=shutil.ignore_patterns("__pycache__"))
        return folder

    def test_importing_from_an_app_bundle_leaves_no_bytecode_there(self):
        with tempfile.TemporaryDirectory() as d:
            scripting = self._copy(d, "X.app", "Contents", "Resources", "scripting")
            before = sorted(str(p.relative_to(d)) for p in Path(d).rglob("*"))
            done = _import_from(scripting)
            self.assertEqual(done.returncode, 0, done.stderr)
            where, flag = done.stdout.split()
            self.assertIn("X.app/Contents/Resources/scripting/qnet", where, "the copy in the bundle is the one imported")
            self.assertEqual(flag, "True")
            self.assertEqual([str(p.relative_to(d)) for p in Path(d).rglob("__pycache__")], [])
            self.assertEqual(sorted(str(p.relative_to(d)) for p in Path(d).rglob("*")), before, "the bundle is as it was")

    def test_a_copy_outside_an_app_keeps_its_bytecode(self):
        with tempfile.TemporaryDirectory() as d:
            folder = self._copy(d, "qnet-python")
            done = _import_from(folder)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(done.stdout.split()[1], "False")
            if not list(Path(d).rglob("*.pyc")):
                self.skipTest("this Python writes no bytecode of its own accord")
            self.assertTrue((folder / "qnet" / "__pycache__").is_dir())


def _alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _gone(pid, within=5.0):
    end = time.monotonic() + within
    while time.monotonic() < end:
        if not _alive(pid):
            return True
        time.sleep(0.05)
    return not _alive(pid)


class StoppingTheTool(unittest.TestCase):
    """A stand-in `qnet-cli` that starts a child and waits for it, as `qnet-cli run` waits for a solver."""

    def setUp(self):
        self.before = (_cli._explicit, _cli.STOP_GRACE)
        self.dir = tempfile.TemporaryDirectory()
        self.pidfile = Path(self.dir.name) / "child.pid"
        tool = Path(self.dir.name) / "qnet-cli"
        # A background job of a non-interactive shell ignores SIGINT, so this child outlives an
        # interrupt and is only reached by killing the group: the stubborn case.
        tool.write_text(f'#!/bin/sh\nsleep 300 &\necho $! > "{self.pidfile}"\nwait\n')
        tool.chmod(0o755)
        qnet.set_cli(tool)
        _cli.STOP_GRACE = 0.5

    def tearDown(self):
        _cli._explicit, _cli.STOP_GRACE = self.before
        if self.pidfile.is_file():
            try:
                os.kill(int(self.pidfile.read_text()), signal.SIGKILL)
            except (OSError, ValueError):
                pass
        self.dir.cleanup()

    def _child(self):
        end = time.monotonic() + 10
        while time.monotonic() < end and not (self.pidfile.is_file() and self.pidfile.read_text().strip()):
            time.sleep(0.02)
        return int(self.pidfile.read_text())

    def test_a_timeout_stops_the_tool_and_what_it_started(self):
        with self.assertRaises(qnet.QnetError) as e:
            _cli.call(["run", "x.bnet"], timeout=1.5)
        self.assertEqual(str(e.exception), "qnet-cli run did not finish within 1.5 seconds and was stopped.")
        child = self._child()
        self.assertTrue(_gone(child), "the tool's child is still running after the timeout")

    def test_an_interrupt_stops_the_tool_and_what_it_started(self):
        # ⌃C in a script: KeyboardInterrupt is raised in the main thread while it waits for the tool.
        def interrupt():
            self._child()
            os.kill(os.getpid(), signal.SIGINT)

        threading.Thread(target=interrupt, daemon=True).start()
        with self.assertRaises(KeyboardInterrupt):
            _cli.call(["run", "x.bnet"], timeout=60)
        self.assertTrue(_gone(self._child()), "the tool's child is still running after the interrupt")

    def test_the_tool_runs_in_its_own_process_group(self):
        tool = Path(self.dir.name) / "qnet-cli"
        tool.write_text("#!/bin/sh\nps -o pgid= -p $$\n")
        code, out, _ = _cli.call(["describe"])
        self.assertEqual(code, 0)
        self.assertNotEqual(int(out), os.getpgrp())
