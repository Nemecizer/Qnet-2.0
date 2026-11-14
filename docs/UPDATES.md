# Automatic updates: built, and switched off

Qnet can update itself, but no copy does until the owner switches it on. This page is what to do
on that day. Until then nothing here needs doing: an ordinary build has no update address, never
contacts an update server, and Qnet ▸ Check for Updates… says "This copy of Qnet does not check
for updates."

## How it is switched

Two environment variables, read when the app is **compiled** (`src-tauri/src/updates.rs`):

| Variable | What it is |
| --- | --- |
| `QNET_UPDATE_ENDPOINT` | The `https://` address of `latest.json` |
| `QNET_UPDATE_PUBKEY` | The public half of the signing key (the contents of the `.pub` file) |

Both set: the app checks that address (at launch, at most once a day, if Settings ▸ General ▸
"Check for updates automatically" is on; and from Qnet ▸ Check for Updates…) and installs only a
download signed with the matching private key. Either missing: updates are off. Nothing in the
repository sets them, `tauri.conf.json` has no updater section, and a test
(`updates::tests::nothing_tracked_switches_updates_on`) keeps it so.

## The day updates are switched on

1. **Make the key** (once, the owner, on the owner's Mac; never in the repository folder):

   ```sh
   mkdir -p ~/.qnet-keys && chmod 700 ~/.qnet-keys
   npx tauri signer generate -w ~/.qnet-keys/qnet-update.key
   ```

   Give it a password when asked. This writes the private key (`qnet-update.key`) and the public
   key (`qnet-update.key.pub`).

   Then put the password in the login keychain, once, so the build can sign without anyone
   typing or seeing it:

   ```sh
   security add-generic-password -s qnet-update-key -a "$USER" -w
   ```

   (it asks for the password twice). `scripts/with-update-key.sh <command>` then runs one command
   with every variable in step 3 set: the endpoint and download address of the public GitHub
   repository, the public key, and the private key's path and password from the keychain.

2. **Where the private key lives.** In `~/.qnet-keys/` (not synced), with a copy in a password
   manager or on an encrypted disk, and its password somewhere else. It must **not** be in this
   repository, in Dropbox or iCloud, in a `.env` file, in a script, in a CI log or in a chat.
   `scripts/update-artifact.sh` refuses a key inside the repository. If the key is lost, installed
   copies can never be updated again (users must download by hand); if it leaks, anyone who can
   serve the update address can install software on users' Macs. The public key is not secret,
   but it is not tracked either: it goes in through the environment.

3. **Build the release** with updates on (after the release checklist in `docs/DEVELOPING.md`: `npm run check`, `scripts/coverage-experiments.sh`, `validation/steady_state_suite.sh`):

   ```sh
   export QNET_UPDATE_ENDPOINT="https://<host>/<path>/latest.json"
   export QNET_UPDATE_PUBKEY="$(cat ~/.qnet-keys/qnet-update.key.pub)"
   export TAURI_SIGNING_PRIVATE_KEY_PATH=~/.qnet-keys/qnet-update.key
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD='<the password>'
   export QNET_UPDATE_DOWNLOAD_URL="https://<host>/<path>/Qnet.app.tar.gz"   # where the archive will be
   export QNET_UPDATE_NOTES_FILE=/path/to/notes.md                           # optional release notes
   scripts/build-candidate.sh qnet-2-1-release
   scripts/notarize.sh ../Qnet-builds/<candidate>
   scripts/update-artifact.sh ../Qnet-builds/<candidate>     # again, so the archive holds the stapled app
   ```

   With the first two variables unset the same scripts build exactly as before and need no key.
   `scripts/update-artifact.sh` writes `<candidate>/update/`: `Qnet.app.tar.gz` (the whole
   assembled app), `Qnet.app.tar.gz.sig` and `latest.json`. Tauri's own `createUpdaterArtifacts`
   is deliberately not used: it would archive the bare app before `assemble-bundle.sh` adds the
   solvers, and it makes every build demand the key.

4. **`latest.json`**, as the script writes it and the app reads it:

   ```json
   {
     "version": "2.1.0",
     "notes": "Plain text or simple Markdown (headings, bullets). Shown as text, never as HTML.",
     "pub_date": "2027-01-05T10:00:00Z",
     "platforms": {
       "darwin-aarch64": {
         "signature": "<the contents of Qnet.app.tar.gz.sig>",
         "url": "https://<host>/<path>/Qnet.app.tar.gz"
       }
     }
   }
   ```

   A copy updates when `version` is higher than its own. The signature names the version it was
   made for (`--app-version`), and the app refuses a mismatch, so an old signed archive cannot be
   served as a new version.

5. **Publish.** `scripts/publish-source.sh "<message>" v2.1.0` publishes the source and the tag;
   it carries no binaries. Attach `Qnet.app.tar.gz` (and the `.pkg`/`.zip` for first-time
   downloads) to the GitHub release of that tag (`gh release create v2.1.0 …` or
   `gh release upload`), and serve `latest.json` from the endpoint address. With GitHub releases
   the two addresses can be `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`
   and `…/releases/download/v2.1.0/Qnet.app.tar.gz` (then upload `latest.json` to each release too).
   Upload the archive first and `latest.json` last. The first version built with updates on
   cannot be reached by updating: people install it by hand once.

## Trying it with a local file server

The app accepts an `http://` endpoint only in a debug build. Use a throwaway key
(`npx tauri signer generate -w /tmp/qnet-test.key`), never the real one.

- **The check and the sheet only:** `QNET_UPDATE_ENDPOINT=http://127.0.0.1:8765/latest.json
  QNET_UPDATE_PUBKEY="$(cat /tmp/qnet-test.key.pub)" npm run tauri dev`, with a hand-written
  `latest.json` (a higher `version`) served by `python3 -m http.server 8765 --bind 127.0.0.1`.
  Install is refused there: a development binary is not an app bundle.
- **The whole path:** make an archive with `scripts/update-artifact.sh` from an existing candidate
  (test key, `QNET_UPDATE_DOWNLOAD_URL` unset, then edit `url` in `update/latest.json` to
  `http://127.0.0.1:8765/Qnet.app.tar.gz`) and serve `update/`. Build an older-looking debug app
  with the same two variables: `npx tauri build --debug --bundles app --config '{"version":"1.9.0"}'`,
  copy `~/Library/Caches/qnet/target/debug/bundle/macos/Qnet.app` to a scratch folder and open it.
  Check for Updates… should offer the candidate's version, download, verify, replace the scratch
  copy and relaunch into it. Then serve an archive signed with a different key: it must be refused
  with "…isn't signed by Qnet's author…" and the app left as it was.

Without a network at all, `npm run dev:mock` shows every sheet: `/mock.html?updates=available`,
`=current`, `=offline`, `=badsig`.

## What has and has not been exercised

The decision logic, every sheet and the refusal paths are tested (`src/updates/*.test.*`,
`src-tauri/src/updates.rs`). No key has been made and nothing has been published, so signing,
the real download and the in-place replacement have never run: do the local test above before
the first public release with updates on.
