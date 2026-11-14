# HELP — General Preferences

## WHAT THIS PANE CONTROLS

Non-algorithmic application behaviour: tab persistence across app launches, and the default answer for the Run Comparison blocking-mode dialog.

## SETTINGS (Settings ▸ General)

```
On quit:
  Ask                          — default.  On relaunch the app
                                 prompts whether to reopen the tabs
                                 that were open when you quit.
  Always restore               — reopen automatically, no prompt.
  Never restore                — start with a fresh blank tab.

Remember blocking choice:
  When OFF (default), every "Run Comparison" invocation pops up a
  dialog asking which buffer-blocking regime the simulation should
  use for the comparison run.  When ON, that dialog is skipped
  and the "Default blocking regime" below is used silently.  The
  dialog itself has a "Skip this dialog from now on" checkbox
  that turns this on.

Default blocking regime:
  The preselected buffer-blocking regime, used whenever
  "Remember blocking choice" is on *or* when the user just presses
  Enter on the dialog.  It is shown here and set in Settings ▸
  Discrete-Event Simulation ▸ Blocking mode ("Change…" opens it).
    Loss                   — arrivals to a full buffer are
                             discarded entirely.
    BAS                    — "Blocking After Service": server
                             holds the job until downstream
                             clears.  External arrivals queue
                             in the source.
    BAS + external loss    — same as BAS but external arrivals
                             to a full station are lost.  This
                             matches the RBM approximation
                             semantics most closely and is the
                             recommended default for
                             comparisons.
```

## NOTES

These preferences are persisted in Qnet's settings file (settings.json in the app's data folder).  They affect behaviour across all tabs and all sessions; there is no per-tab override.  "Reset to Defaults" resets only the fields in this pane, not the contents of any open tab.
