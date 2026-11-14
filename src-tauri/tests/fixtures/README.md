# Test fixtures

`settings-0.90.34-constructed.json` is **constructed, not exported**. No settings file written by
Qnet 0.90.34 was in the repository when the P4 import test was written, so this one was built to
be what `AppSettings.exportedSettingsJSON()` (0.90.34 `Sources/Qnet/AppSettings.swift`) writes:

- every one of the 108 keys of `AppSettings.defaultsByKey`, each holding a value that is *not* its
  default (so an import that dropped or reset a key would show), plus the metadata keys
  `qnet.settingsFormat` (1), `qnet.exportedAt` and `qnet.appVersion` ("0.90.34.09.04.2026.1534");
- `JSONSerialization` with `[.prettyPrinted, .sortedKeys]`: two-space indent, `"key" : value`,
  keys in code-point order, `/` written as `\/`, non-ASCII written as UTF-8, no final newline;
- numbers as an `NSNumber` prints them: Int keys as integers, Double keys in their shortest form
  (`0.25`, `0.0001`) and a whole Double without a fraction (`"shell.fontSize" : 14`), Bool keys as
  `true` / `false`.

`mlmc.threads` is 1, which every Mac accepts (its import range is 0…the importing Mac's core count).
An older Foundation may print a Double with 17 digits (`0.69999999999999996`); that parses to the
same number, and `settings_io.rs` has a test for it.

The Rust test `settings_io::tests::a_0_90_34_export_imports_with_every_value_intact` imports this
file and checks every value; `every_settings_export_in_the_handoff_folder_imports_intact` runs the
same check on any real 0.90.34 export placed in `6_QNET20/handoff/` (a `.json` with a
`qnet.settingsFormat` key).
