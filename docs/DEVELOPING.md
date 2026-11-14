# Developing Qnet

How the source is laid out, how to check a change, and how a release is built. What Qnet does is in the [README](../README.md).

## Layout

| Piece | Where |
|---|---|
| Interface (React, TypeScript) | `src/` — `App.tsx`, `styles.css` (colour tokens), `lib/` (the command list, menu description, IPC in `api.ts`, words in `vocabulary.ts`), one folder per area (`canvas/`, `panes/`, `results/`, `sweeps/`, `tour/`, `welcome/`, …), the browser preview's stand-in backend in `dev/` |
| App (Rust, Tauri 2) | `src-tauri/src/` — commands registered in `lib.rs`, windows, native menu, settings, documents, the AI providers in `ai/`, updates |
| Model and analyses (Rust) | `core/src/` — the network model and `.bnet` files, traffic equations, tractability, the exporters, the result parser, and the in-process methods (product form, closed networks, priorities, batches, transient, sensitivity, capacity, uncertainty, simulation) |
| Solver runner | `runner/src/` — finding and running the external solvers, the results store |
| Command-line tool | `cli/` — `qnet-cli` ([CLI.md](CLI.md)) |
| Python package | `python/` — `qnet`, over `qnet-cli` |
| Solvers (C and Python) | `solvers/{infinite,finite,common}/`, each with its own `make check` |
| Example networks | `examples/` |
| Reference outputs the tests compare against | `golden/` |
| Help articles | `docs/help/` (Markdown, listed in `manifest.json`) |
| Behaviour ledger | `docs/PARITY.md`: one row per behaviour, each Done, Changed (with the reason) or Dropped |
| Scripts | `scripts/` (build, check, release), `validation/` (the steady-state suite and fuzzing) |

## Requirements

An Apple Silicon Mac with Xcode's command-line tools, Rust (in `~/.cargo/bin`) and Node. Build products are kept outside the repository, under `~/Library/Caches/qnet` (Cargo's target folder, the solver and library builds, the staged Python), so the repository can live in a synced folder; `scripts/cargo-config.sh` writes the untracked `.cargo/config.toml` that points Cargo there.

## Working on it

```bash
npm install
```

```bash
npm run check
```

Type checks, the interface tests, the Rust tests (including the comparisons with `golden/`), the Python package's tests, and the lints for help, versions and licence notices. A change is done when this passes.

```bash
npm run dev:mock
```

The browser preview at http://localhost:1450/mock.html, with a stand-in backend: no solvers, recorded results.

```bash
npm run tauri dev
```

The app itself. `QNET_SELFTEST=aux npm run tauri dev` runs its self-test and prints `QNET SELFTEST OK` or `FAIL`.

```bash
scripts/stage-solvers.sh
```

Builds the native solvers for macOS 14 against Qnet's own builds of SuiteSparse, HiGHS, cJSON and LLVM OpenMP (`scripts/build-deps.sh` fetches pinned, checksummed sources), and stages them with the Python solvers. Needed before the runner tests or a run from `qnet-cli`.

```bash
cargo run -q -p qnet-cli -- run qna examples/10stationtandem.inf.bnet
```

Runs one method from the command line with the staged solvers.

Conventions: every file opens with a prose header saying what it is and why; test names are sentences; words the interface shows live in each area's `words.ts` or `src/lib/vocabulary.ts`; colours come from the tokens in `src/styles.css` (contrast is tested); every new Rust command gets a typed method in `src/lib/api.ts` and a handler under `src/dev/mock/`; a change of behaviour gets a row in `docs/PARITY.md`.

## Building a release

```bash
scripts/build-candidate.sh <what-is-being-tested>
```

A complete, signed app in a dated folder beside the repository (`../Qnet-builds/`), built from a clean commit: solvers, libraries, Python, examples, licences and `qnet-cli` inside, signed with a Developer ID certificate when the keychain has one. It never launches the app.

```bash
scripts/notarize.sh ../Qnet-builds/<candidate>
```

```bash
scripts/make-pkg.sh ../Qnet-builds/<candidate>
```

Notarizes and staples the app (notarytool credentials stored under the keychain profile `qnet-notary`), then makes the installer. Notarize the installer with `xcrun notarytool submit … --wait` and staple it.

Release checklist, in this order: `npm run check`; `scripts/coverage-experiments.sh` (the simulation methods' interval coverage, every count inside its band); `QNET_DOCS_SLOW=1 scripts/check-python.sh`; `validation/steady_state_suite.sh ../Qnet-builds/<candidate>/Qnet.app`; then build, notarize and publish.

Releases carry automatic updates. Build and sign them through `scripts/with-update-key.sh` (for example `scripts/with-update-key.sh scripts/build-candidate.sh <name>`, and again for `scripts/update-artifact.sh` after notarizing), and attach `Qnet.app.tar.gz` before `latest.json` to the GitHub release. [UPDATES.md](UPDATES.md) has the details and the signing key's rules.

```bash
scripts/publish-source.sh "Qnet <version>" v<version>
```

Publishes the committed source to GitHub as one snapshot commit under the account's no-reply address, and tags it. It refuses a tree in which a tracked file names the build machine's home folder or the commit email. Then create the GitHub release with the installer, the zipped app, the update files and `SHA256SUMS.txt`.

The version is written in several places; `node scripts/verify-version.mjs` says whether they agree, and `src-tauri/tauri.conf.json` is the one that counts. The release notes shown in the app are `src/windows/releasenotes/changelog.ts`.
