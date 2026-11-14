# HELP — Shell Pane

## WHAT THIS PANE CONTROLS

Appearance of the integrated terminal (the window/pane where the algorithms print their output).  These are cosmetic settings only; they do not affect the algorithms themselves.

## SETTINGS (Settings ▸ Panes)

```
Font:
  Any of the fixed-width font families that ship with macOS.  "System Monospaced
  (default)" is a sensible, fixed-width system font that aligns
  numeric output in columns correctly.  Proportional fonts are
  not offered: table output wouldn't line up.

Text size:
  Point size, 8–28.  Takes effect immediately in the terminal
  pane.  Consider size 13–14 on high-DPI displays and 12 on
  standard-density.
```

## NOTES

The terminal is a PTY-backed emulator that honours ANSI colour codes and most escape sequences (cursor movement, erase, colour). Algorithm output uses minimal colouring; the font/size settings here apply uniformly.  For per-session colour themes or more elaborate shell customization, use .bashrc / .zshrc in your usual shell — this pane is only for the font.
