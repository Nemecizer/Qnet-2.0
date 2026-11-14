"""Finding the `qnet-cli` the tests run against: the debug build cargo made, unless QNET_CLI says otherwise.

The tests never fall back to an installed Qnet.app: that could be another version. Where no
tool is found every test that needs one is skipped, with this module's message.
"""

import os
import re
import unittest
from pathlib import Path

import qnet

ROOT = Path(__file__).resolve().parents[2]


def _debug_cli():
    if os.environ.get("QNET_CLI"):
        return Path(os.environ["QNET_CLI"])
    targets = []
    if os.environ.get("CARGO_TARGET_DIR"):
        targets.append(Path(os.environ["CARGO_TARGET_DIR"]))
    config = ROOT / ".cargo" / "config.toml"
    if config.is_file():
        m = re.search(r'^\s*target-dir\s*=\s*"([^"]+)"', config.read_text(), re.M)
        if m:
            targets.append(Path(m.group(1)))
    targets += [Path.home() / "Library" / "Caches" / "qnet" / "target", ROOT / "target"]
    for t in targets:
        if (t / "debug" / "qnet-cli").is_file():
            return t / "debug" / "qnet-cli"
    return None


CLI = _debug_cli()
SKIP = "no qnet-cli to test against: build it (cargo build -p qnet-cli) or set QNET_CLI"
if CLI is not None and CLI.is_file():
    qnet.set_cli(CLI)
    HAVE_CLI = True
else:
    HAVE_CLI = False

needs_cli = unittest.skipUnless(HAVE_CLI, SKIP)


def solvers_ready():
    """Whether this checkout's solvers are staged (scripts/stage-solvers.sh), which `solve` needs."""
    if not HAVE_CLI:
        return False
    try:
        qnet.Network.tandem(1, 0.5, 1.0).solve("qna")
        return True
    except qnet.QnetError:
        return False
