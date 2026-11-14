# WHEN A RUN FAILS

Sometimes a method cannot give an answer: the network is overloaded, the problem is too large for the method, or the solver itself goes wrong. Qnet tells you which it was, in plain words, and keeps a report on your Mac.

## SEEING WHAT HAPPENED

When a run fails, its line in the Status pane gets a Show Report… button. The Failure Report panel says:

- what happened, in one sentence;
- why, and whether your network is the cause or not;
- what to try next, most useful first. Where another method could work instead, there is a button that runs it.

The usual causes and what they mean:

- The network is unstable. At some station work arrives faster than it can be served, so the queue grows without limit and there is no steady state to compute. With infinite buffers no method can give steady-state values then: some methods refuse to run, and a simulation runs but never settles. Raise the service rate or the number of servers, lower the arrival rate, or switch Network ▸ Buffer Model to finite buffers.
- The method needs more memory than is safe. The network is valid, but this method is too expensive for it at these settings. The panel says which setting to lower.
- The network is too large for the method. Multi-Class SRBM solves on a mesh over all the stations at once, and from about five stations the mesh no longer fits. The panel names the methods the Method Chooser recommends for that network, offers the first as a button, and gives the coarser mesh that would fit when there is one.
- The method did not converge. Its iteration did not settle, so it reported nothing instead of a wrong number. This is more common when a station is close to full utilization.
- The solver stopped unexpectedly, or could not start. This is a fault in Qnet or in this copy of it, not in your network. Nothing you entered is wrong, and your network has not been changed.
- The run finished but gave no usable result. The solver ended normally, but Qnet could not read measurements from its output.

A run that you stop yourself is not a failure and gets no report.

## WHAT IS IN A REPORT

Each failed run gets a folder of its own with:

- report.json: the Qnet version and build, the macOS version, the chip, the method and its settings, the command lines, how the run ended (exit status or signal), how long it took, and which solver and Python were used;
- the solver input files, exactly as the run wrote them (a very large one is left out and only named);
- network.bnet: the network as it was run;
- stderr.txt: what the solver wrote as error output;
- output-tail.txt: the last 200 lines of the run's output.

Paths are written without your home folder: it appears as ~. Anything that reads like a key, a token or a password is left out, and so are the AI Assistant's settings.

## WHERE REPORTS ARE KEPT

Help ▸ Show Failure Reports… opens the folder in Finder. It is the reports folder inside Qnet's own data folder in your Library. Reveal in Finder in the panel shows the folder of one report.

Qnet keeps the newest 20 reports and deletes older ones.

## NOTHING IS SENT ANYWHERE

A report stays on your Mac. Qnet does not upload it and does not use the network for it. It leaves the Mac only if you send it yourself.

If you want to ask for help, Copy Report puts a short summary on the clipboard, ready to paste into an email. The summary names no folder of yours. To send everything, use Reveal in Finder and attach the folder.
