"""Qnet from Python: build a queueing network, solve it and sweep it from a script or a notebook.

    import qnet

    net = qnet.Network.tandem(stations=2, arrival_rate=0.8, service_rates=1.0)
    print(net.solve())                       # the method Qnet's Solve button would run
    print(net.sweep("Src1.rate", [0.5, 0.7, 0.9], method="live"))

This package is a thin layer over Qnet's command-line tool, `qnet-cli`: every number comes from
the same code the app runs, and a network saved here opens in the app. The package itself is
plain Python (standard library only; NumPy, pandas and matplotlib are used when present and never
required). It contacts nothing: no network access, no telemetry.

`qnet-cli` is looked for in this order: `qnet.set_cli(path)`, the environment variable
`QNET_CLI`, the Qnet.app this package sits in, `/Applications/Qnet.app`, `~/Applications/Qnet.app`,
then `PATH`.
"""

import sys as _sys

# Inside a signed Qnet.app nothing may be written: a `__pycache__` folder there breaks the app's
# code signature. So when this package is imported from inside an application bundle, Python is
# told not to write bytecode from here on (which covers this package's other modules), and the one
# file Python had already written before this line could run, this file's own bytecode, is taken
# away again. Anywhere else (a copy, a pip install) bytecode is kept as usual.
if ".app/Contents/" in __file__.replace("\\", "/") and not _sys.dont_write_bytecode:
    _sys.dont_write_bytecode = True
    try:
        import os as _os

        _cache = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "__pycache__")
        for _name in _os.listdir(_cache):
            if _name.startswith("__init__.") and _name.endswith(".pyc"):
                _os.remove(_os.path.join(_cache, _name))
        _os.rmdir(_cache)  # only when that left it empty
    except OSError:
        pass

from ._cli import QnetError, CliNotFound, NotApplicable, RunFailed, cli_version, find_cli, set_cli
from .network import Method, Network
from .results import (
    CapacityResult,
    LiveResult,
    Result,
    SensitivityResult,
    SolveResult,
    SweepResult,
    TransientResult,
    UncertaintyResult,
    Value,
)

# The app's version (scripts/verify-version.mjs keeps this line and pyproject.toml in step).
__version__ = "2.1.2"

__all__ = [
    "CapacityResult",
    "CliNotFound",
    "LiveResult",
    "Method",
    "Network",
    "NotApplicable",
    "QnetError",
    "Result",
    "RunFailed",
    "SensitivityResult",
    "SolveResult",
    "SweepResult",
    "TransientResult",
    "UncertaintyResult",
    "Value",
    "cli_version",
    "find_cli",
    "set_cli",
]
