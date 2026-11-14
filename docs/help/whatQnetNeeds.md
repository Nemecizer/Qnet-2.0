# WHAT QNET NEEDS

Qnet needs a Mac with Apple silicon and macOS 14 or later. That is all.

## NOTHING TO INSTALL

Everything Qnet runs is inside the app:

- every solver, and the numerical libraries the solvers use;
- its own Python, with NumPy, for the methods that are written in Python.

You do not need to install Python, NumPy, Homebrew, a compiler or any library, and nothing you have installed changes how Qnet computes. If your Mac has its own Python, Qnet leaves it alone.

## CHECKING

Help ▸ Check Dependencies… lists each part Qnet carries and confirms that it is in the app and starts. In the app as you downloaded it, no row asks you to install anything.

If a row there reports a problem, the copy of Qnet is damaged or incomplete. Download it again; installing something else on the Mac will not repair it.

## THE AI ASSISTANT IS SEPARATE

The AI Assistant pane is optional and is the one part of Qnet that talks to something outside the app: a provider you choose and set up yourself. See [Anthropic](help:connectAnthropic), [LM Studio](help:connectLMStudio) and [Ollama](help:connectOllama). Qnet computes every result without it.

## UPDATES

This copy of Qnet does not check for updates unless it was built with an update address. Qnet ▸ Check for Updates… says which kind this copy is; a copy built without one never contacts a server to look for a newer version.

## YOUR FILES

Networks are .bnet files that you save where you like. Qnet keeps its settings, the record of your runs and its failure reports in its own data folder in your Library. See [When a run fails](help:runFailures) for what a failure report holds.
