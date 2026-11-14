"""Finding and calling `qnet-cli`. Nothing else in the package starts a process."""

import json
import os
import shutil
import signal
import subprocess
from pathlib import Path

#: The schema of the JSON documents this package reads (docs/CLI.md).
SCHEMA = 1

#: Where the app keeps the tool (scripts/assemble-bundle.sh: Contents/MacOS/qnet-cli).
APP_CLI = "Contents/MacOS/qnet-cli"


class QnetError(Exception):
    """Something Qnet said in plain words: a network it cannot read, options that make no sense."""


class CliNotFound(QnetError):
    """`qnet-cli` could not be found."""


class NotApplicable(QnetError):
    """The analysis does not cover this network; the message says why."""

    def __init__(self, message, reason=None, document=None):
        super().__init__(message)
        #: Qnet's short reason code ("notJackson", "unstable", "closed", …), when it gives one.
        self.reason = reason
        self.document = document


class RunFailed(QnetError):
    """A method was refused, failed or was stopped; the message is what Qnet's Status log says."""

    def __init__(self, message, document=None):
        super().__init__(message)
        #: The JSON document `qnet-cli run --json` printed, when it printed one.
        self.document = document


_explicit = None


def set_cli(path):
    """Use this `qnet-cli` from now on (None: go back to looking for it)."""
    global _explicit
    if path is None:
        _explicit = None
        return
    p = Path(path).expanduser()
    if not (p.is_file() and os.access(p, os.X_OK)):
        raise CliNotFound(f"{p} is not a program that can be run. Give qnet.set_cli the path to qnet-cli itself.")
    _explicit = str(p)


def _candidates():
    """(where it was looked for, path) in the order of the package's documentation."""
    out = []
    env = os.environ.get("QNET_CLI")
    if env:
        out.append(("the environment variable QNET_CLI", Path(env).expanduser()))
    # Inside the app, the package is Contents/Resources/scripting/qnet/.
    here = Path(__file__).resolve()
    if len(here.parents) > 3 and here.parents[3].name == "Contents":
        out.append(("the Qnet.app this package is in", here.parents[3] / "MacOS" / "qnet-cli"))
    out.append(("/Applications/Qnet.app", Path("/Applications/Qnet.app") / APP_CLI))
    out.append(("~/Applications/Qnet.app", Path.home() / "Applications" / "Qnet.app" / APP_CLI))
    on_path = shutil.which("qnet-cli")
    if on_path:
        out.append(("PATH", Path(on_path)))
    return out


def find_cli():
    """The path of the `qnet-cli` this package will call, or CliNotFound saying where it looked."""
    if _explicit:
        return _explicit
    for where, path in _candidates():
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
        if where == "the environment variable QNET_CLI":
            raise CliNotFound(f"QNET_CLI is set to {path}, which is not a program that can be run.")
    raise CliNotFound(
        "Qnet's command-line tool, qnet-cli, was not found. It is inside the app, at "
        "/Applications/Qnet.app/Contents/MacOS/qnet-cli. Install Qnet in Applications, or say where the tool is "
        "with qnet.set_cli(\"/path/to/qnet-cli\") or the environment variable QNET_CLI."
    )


#: Seconds `qnet-cli` is given to stop its solvers after it is asked to stop, before it and
#: everything left in its process group is killed. The tool's own ladder for a solver is an
#: interrupt at once, SIGTERM at 1.5 s and SIGKILL at 3 s (runner/src/supervisor/process.rs).
STOP_GRACE = 5.0


def _stop(process):
    """Stops `qnet-cli` and what it started, and waits until it has gone.

    The tool runs in its own session, so its process group is its own. It is interrupted first:
    `qnet-cli run` answers an interrupt by stopping its solver (which it keeps in a process group
    of its own, out of this one's reach) and exits when the solver has. Whatever is still in the
    tool's group after STOP_GRACE seconds is killed.
    """
    for sig, wait in ((signal.SIGINT, STOP_GRACE), (signal.SIGKILL, None)):
        try:
            os.killpg(process.pid, sig)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            process.communicate(timeout=wait)
        except subprocess.TimeoutExpired:
            continue
        except (OSError, ValueError):
            pass
        if sig == signal.SIGINT:
            # The tool has exited; anything it left behind in its group goes with it.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        return


def call(args, stdin=None, timeout=None):
    """Runs `qnet-cli args…` and returns (exit status, stdout, stderr).

    When the time runs out, or the script is interrupted (⌃C, a notebook's Stop), the tool and the
    solvers it started are stopped before this returns or raises.
    """
    cli = find_cli()
    try:
        process = subprocess.Popen(
            [cli, *args],
            stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            start_new_session=True,
        )
    except OSError as e:
        raise CliNotFound(f"{cli} could not be started: {e}.") from None
    try:
        out, err = process.communicate(stdin, timeout=timeout)
    except subprocess.TimeoutExpired:
        _stop(process)
        raise QnetError(f"qnet-cli {args[0]} did not finish within {timeout} seconds and was stopped.") from None
    except BaseException:
        # KeyboardInterrupt above all: the tool is in its own session and did not get the ⌃C.
        _stop(process)
        raise
    return process.returncode, out, err


def plain(stderr):
    """What qnet-cli said on stderr, as sentences: Status lines without their severity column."""
    lines = []
    for line in stderr.splitlines():
        line = line.strip()
        if not line:
            continue
        severity, tab, text = line.partition("\t")
        if tab and severity in ("info", "success", "warning", "error"):
            if severity in ("warning", "error"):
                lines.append(text)
        elif line.startswith("qnet-cli: "):
            lines.append(line[len("qnet-cli: "):])
        else:
            lines.append(line)
    return "\n".join(lines)


def document(text, what):
    """The JSON document a command printed, checked for its schema."""
    try:
        doc = json.loads(text)
    except ValueError:
        raise QnetError(f"qnet-cli {what} did not print the JSON this package expects. Is {find_cli()} from an older Qnet?") from None
    if not isinstance(doc, dict) or doc.get("schema") != SCHEMA:
        said = doc.get("schema") if isinstance(doc, dict) else None
        raise QnetError(f"qnet-cli {what} printed schema {said}; this qnet package reads schema {SCHEMA}. Use the package that came with that Qnet.")
    return doc


def json_command(args, stdin=None, timeout=None):
    """A command that prints one JSON document; its stderr sentence as a QnetError otherwise."""
    code, out, err = call(args, stdin=stdin, timeout=timeout)
    if code != 0:
        message = plain(err) or f"qnet-cli {args[0]} failed with exit status {code}."
        if code == 2 and "Usage:" in message:
            message = f"This qnet-cli does not know the command “{args[0]}” as this package calls it. Is {find_cli()} from an older Qnet?"
        raise QnetError(message)
    return document(out, args[0])


def cli_version():
    """What `qnet-cli --version` says, e.g. "Qnet 2.1.0"."""
    code, out, err = call(["--version"])
    if code != 0:
        raise QnetError(plain(err) or "qnet-cli --version failed.")
    return out.strip()
