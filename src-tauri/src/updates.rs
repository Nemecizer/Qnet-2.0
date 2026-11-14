//! Automatic updates, built ready and switched off (A5, ledger UX-501…; docs/UPDATES.md).
//!
//! Whether this copy of Qnet can update itself is decided when it is compiled: the build reads
//! `QNET_UPDATE_ENDPOINT` (where `latest.json` is) and `QNET_UPDATE_PUBKEY` (the public half of the
//! owner's signing key) from the environment. Neither is in the repository, so an ordinary build
//! has no configuration: the updater plugin is then never registered, `update_check` answers
//! `Disabled` before anything that could make a request exists (`check_with`), and the interface
//! says "This copy of Qnet does not check for updates."
//!
//! With both set, the plugin is registered with that endpoint and key (`configure`, `setup`), and
//! the interface (src/updates/) decides when to ask: at launch at most once a day, or from
//! Qnet ▸ Check for Updates…. The download's signature is verified by the plugin against the key
//! compiled in; nothing unverified is ever installed. The plugin is used from Rust only: its own
//! page-side commands have no permission in capabilities/default.json, so the page can reach the
//! updater through the four commands here and no other way.

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::UpdaterExt;

use crate::errors::{ErrorKind, QnError};

/// Where to look and whose signature to accept: both compiled in, or there is no updater.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateConfig {
    pub endpoint: String,
    pub pubkey: String,
}

/// The configuration two build-time values make, if they make one: both present and not blank,
/// and the endpoint an `https://` address. `http://` is taken only by a debug build, for the
/// local-file-server test in docs/UPDATES.md (the plugin itself refuses it in a release build).
pub fn config_from(endpoint: Option<&str>, pubkey: Option<&str>, debug: bool) -> Option<UpdateConfig> {
    let endpoint = endpoint?.trim();
    let pubkey = pubkey?.trim();
    if endpoint.is_empty() || pubkey.is_empty() {
        return None;
    }
    let url = tauri::Url::parse(endpoint).ok()?;
    let secure = url.scheme() == "https" || (debug && url.scheme() == "http");
    (secure && url.host_str().is_some()).then(|| UpdateConfig { endpoint: endpoint.to_string(), pubkey: pubkey.to_string() })
}

/// This build's configuration: `None` unless it was compiled with both variables set.
pub fn build_config() -> Option<UpdateConfig> {
    config_from(option_env!("QNET_UPDATE_ENDPOINT"), option_env!("QNET_UPDATE_PUBKEY"), cfg!(debug_assertions))
}

/// Gives the updater plugin its endpoint and key (it reads them from the app's configuration,
/// which tauri.conf.json deliberately leaves without an updater section). Does nothing in a build
/// without a configuration. `requireSignedVersion`: the signature must name the version the server
/// announces (scripts/update-artifact.sh signs with `--app-version`), so a server that has been
/// tampered with cannot pass an old, genuinely signed Qnet off as a new one.
pub fn configure(config: &mut tauri::Config) {
    if let Some(c) = build_config() {
        config.plugins.0.insert("updater".into(), serde_json::json!({ "endpoints": [c.endpoint], "pubkey": c.pubkey, "requireSignedVersion": true }));
    }
}

/// The update the last check found, kept for Install.
#[derive(Default)]
pub struct Pending(Mutex<Option<tauri_plugin_updater::Update>>);

/// Registers the updater plugin, only in a build with a configuration.
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(Pending::default());
    if build_config().is_some() {
        app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// Whether this copy was built to check for updates at all.
    configured: bool,
    current_version: String,
}

/// Whether this copy can update itself. Reads nothing but what was compiled in.
#[tauri::command]
pub fn update_status(app: AppHandle) -> UpdateStatus {
    UpdateStatus { configured: build_config().is_some(), current_version: app.package_info().version.to_string() }
}

/// What a check found.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum CheckOutcome {
    /// This copy was not built to check: nothing was contacted.
    Disabled,
    UpToDate,
    #[serde(rename_all = "camelCase")]
    Available { version: String, notes: Option<String>, date: Option<String> },
}

/// A newer version, as an update source reports it, with whatever the source needs to install it.
pub struct Found<U> {
    pub version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
    pub handle: U,
}

/// One check. `look` is the only thing that may reach the network, and it is not called (nor is
/// anything it would need built) unless there is a configuration: tests pass a `look` that panics.
pub async fn check_with<U, F, Fut>(config: Option<&UpdateConfig>, look: F) -> Result<(CheckOutcome, Option<U>), QnError>
where
    F: FnOnce(UpdateConfig) -> Fut,
    Fut: Future<Output = Result<Option<Found<U>>, QnError>>,
{
    let Some(config) = config else { return Ok((CheckOutcome::Disabled, None)) };
    Ok(match look(config.clone()).await? {
        None => (CheckOutcome::UpToDate, None),
        Some(f) => (CheckOutcome::Available { version: f.version, notes: f.notes.filter(|n| !n.trim().is_empty()), date: f.date }, Some(f.handle)),
    })
}

/// What went wrong, for the sentence the interface shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trouble {
    /// The server couldn't be reached, or the download stopped.
    Network,
    /// The server answered, but not with a release this Mac can use.
    Release,
    /// The download is not what the owner signed.
    Signature,
    /// Verified, but it couldn't be put in place.
    Install,
    Other,
}

pub fn trouble(e: &tauri_plugin_updater::Error) -> Trouble {
    use tauri_plugin_updater::Error as E;
    match e {
        E::Reqwest(_) | E::Network(_) | E::ReleaseNotFound => Trouble::Network,
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) | E::SignedVersionMismatch { .. } | E::MissingSignedVersion => Trouble::Signature,
        E::TargetNotFound(_) | E::TargetsNotFound(_) | E::Serialization(_) | E::Semver(_) | E::UnsupportedArch | E::UnsupportedOs | E::InvalidUpdaterFormat | E::BinaryNotFoundInArchive => Trouble::Release,
        E::Io(_) | E::TempDirNotOnSameMountPoint | E::TempDirNotFound | E::PreviousAppNotRestored(_) | E::FailedToDetermineExtractPath => Trouble::Install,
        _ => Trouble::Other,
    }
}

/// The plain-words sentence for each kind of trouble. The plugin's own text goes under Details.
pub fn sentence(t: Trouble) -> (ErrorKind, &'static str) {
    match t {
        Trouble::Network => (ErrorKind::Unavailable, "Qnet couldn't reach the update server. Check the internet connection and try again later."),
        Trouble::Release => (ErrorKind::Unavailable, "The update server has no version of Qnet that this Mac can install."),
        Trouble::Signature => (ErrorKind::Failed, "The update was downloaded, but it isn't signed by Qnet's author, so it was not installed. This copy of Qnet is unchanged."),
        Trouble::Install => (ErrorKind::Failed, "The update was downloaded and verified, but it couldn't be put in place. This copy of Qnet is unchanged. Moving Qnet to the Applications folder may help."),
        Trouble::Other => (ErrorKind::Failed, "Checking for updates didn't work. This copy of Qnet is unchanged."),
    }
}

fn explain(e: tauri_plugin_updater::Error) -> QnError {
    let (kind, message) = sentence(trouble(&e));
    QnError::new(kind, message).with_detail(e.to_string())
}

/// Asks the update server whether there is a newer Qnet. `Disabled`, without a request, in a build
/// with no configuration.
#[tauri::command]
pub async fn update_check(app: AppHandle, pending: State<'_, Pending>) -> Result<CheckOutcome, QnError> {
    let config = build_config();
    let (outcome, update) = check_with(config.as_ref(), |_| async {
        let found = app.updater().map_err(explain)?.check().await.map_err(explain)?;
        Ok(found.map(|u| Found { version: u.version.clone(), notes: u.body.clone(), date: u.date.map(|d| d.date().to_string()), handle: u }))
    })
    .await?;
    *pending.0.lock().unwrap() = update;
    Ok(outcome)
}

/// How much of the download has arrived; `total` when the server said how large it is.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

/// Downloads the version the last check found, verifies its signature and puts it in place of
/// this app. The running copy carries on until `update_relaunch`.
#[tauri::command]
pub async fn update_install(pending: State<'_, Pending>, version: String, channel: Channel<UpdateProgress>) -> Result<(), QnError> {
    let update = pending.0.lock().unwrap().clone().filter(|u| u.version == version);
    let Some(update) = update else {
        return Err(QnError::invalid("That update is no longer the newest one Qnet knows of. Check for updates again."));
    };
    // The updater replaces the folder two levels above the executable. For an app that is
    // Qnet.app; for a bare development binary it would be cargo's build folder.
    if !std::env::current_exe().is_ok_and(|exe| in_app_bundle(&exe)) {
        return Err(QnError::new(ErrorKind::Unavailable, "This copy of Qnet is not an app that can replace itself (it is a development build), so the update was not installed."));
    }
    let mut downloaded = 0u64;
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = channel.send(UpdateProgress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(explain)
}

/// Whether `exe` is the executable of an app bundle: `…/<name>.app/Contents/MacOS/<exe>`.
pub fn in_app_bundle(exe: &std::path::Path) -> bool {
    let mut up = exe.ancestors().skip(1);
    up.next().is_some_and(|d| d.file_name().is_some_and(|n| n == "MacOS"))
        && up.next().is_some_and(|d| d.file_name().is_some_and(|n| n == "Contents"))
        && up.next().is_some_and(|d| d.extension().is_some_and(|x| x == "app"))
}

/// Set while the next agreed quit should start the new version instead of only ending this one.
static RELAUNCH: AtomicBool = AtomicBool::new(false);

/// Arms (or disarms) the relaunch: the interface then quits the ordinary way, so the quit prompt
/// and the session save run as they do for ⌘Q, and `app_exit` restarts instead of exiting.
#[tauri::command]
pub fn update_relaunch(armed: bool) {
    RELAUNCH.store(armed, Ordering::SeqCst);
}

/// Whether the quit now under way is an update's relaunch; asked once by `app_exit`.
pub fn take_relaunch() -> bool {
    RELAUNCH.swap(false, Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block<T>(f: impl Future<Output = T>) -> T {
        tauri::async_runtime::block_on(f)
    }

    fn config() -> UpdateConfig {
        UpdateConfig { endpoint: "https://updates.invalid/latest.json".into(), pubkey: "not-a-key".into() }
    }

    /// The proof that an unconfigured copy contacts nothing: the check answers before the one
    /// thing that could make a request is even called.
    #[test]
    fn with_no_configuration_the_check_is_disabled_before_anything_is_asked() {
        let (outcome, handle) = block(check_with(None, |_| async {
            panic!("an unconfigured build looked for an update");
            #[allow(unreachable_code)]
            Ok(None::<Found<()>>)
        }))
        .unwrap();
        assert_eq!(outcome, CheckOutcome::Disabled);
        assert!(handle.is_none());
        assert_eq!(serde_json::to_value(&outcome).unwrap(), serde_json::json!({ "state": "disabled" }));
    }

    #[test]
    fn a_configured_check_reports_up_to_date_available_and_failure() {
        let c = config();
        let (outcome, _) = block(check_with(Some(&c), |_| async { Ok(None::<Found<()>>) })).unwrap();
        assert_eq!(outcome, CheckOutcome::UpToDate);

        let (outcome, handle) = block(check_with(Some(&c), |got| async move {
            assert_eq!(got.endpoint, "https://updates.invalid/latest.json");
            Ok(Some(Found { version: "2.2.0".into(), notes: Some("Faster charts.".into()), date: Some("2027-01-05".into()), handle: 7 }))
        }))
        .unwrap();
        assert_eq!(handle, Some(7));
        assert_eq!(
            serde_json::to_value(&outcome).unwrap(),
            serde_json::json!({ "state": "available", "version": "2.2.0", "notes": "Faster charts.", "date": "2027-01-05" })
        );

        // Blank notes are no notes.
        let (outcome, _) = block(check_with(Some(&c), |_| async { Ok(Some(Found { version: "2.2.0".into(), notes: Some("  \n".into()), date: None, handle: () })) })).unwrap();
        assert_eq!(outcome, CheckOutcome::Available { version: "2.2.0".into(), notes: None, date: None });

        let err = block(check_with(Some(&c), |_| async { Err::<Option<Found<()>>, _>(explain(tauri_plugin_updater::Error::ReleaseNotFound)) })).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Unavailable);
    }

    #[test]
    fn a_configuration_needs_both_values_and_a_secure_endpoint() {
        assert_eq!(config_from(None, None, false), None);
        assert_eq!(config_from(Some("https://example.invalid/latest.json"), None, false), None);
        assert_eq!(config_from(None, Some("key"), false), None);
        assert_eq!(config_from(Some("  "), Some("key"), false), None);
        assert_eq!(config_from(Some("https://example.invalid/latest.json"), Some(" "), false), None);
        assert_eq!(config_from(Some("not a url"), Some("key"), false), None);
        assert_eq!(config_from(Some("file:///tmp/latest.json"), Some("key"), true), None);
        // http is for the local test server, and only in a debug build.
        assert_eq!(config_from(Some("http://127.0.0.1:8000/latest.json"), Some("key"), false), None);
        assert!(config_from(Some("http://127.0.0.1:8000/latest.json"), Some("key"), true).is_some());
        let c = config_from(Some(" https://example.invalid/latest.json\n"), Some("key\n"), false).unwrap();
        assert_eq!(c, UpdateConfig { endpoint: "https://example.invalid/latest.json".into(), pubkey: "key".into() });
    }

    /// A build made without the two variables (every ordinary build, and `npm run check`) has no
    /// updater: nothing is added to the app's configuration, so the plugin has nothing to read.
    #[test]
    fn a_build_without_the_variables_is_unconfigured() {
        if option_env!("QNET_UPDATE_ENDPOINT").is_none() || option_env!("QNET_UPDATE_PUBKEY").is_none() {
            assert_eq!(build_config(), None);
        }
    }

    /// The repository itself switches nothing on: no updater section, no artifact creation and no
    /// key in tauri.conf.json, no updater permission for the page, and no endpoint or key here.
    #[test]
    fn nothing_tracked_switches_updates_on() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert!(conf.get("plugins").and_then(|p| p.get("updater")).is_none(), "tauri.conf.json has an updater section");
        assert!(conf["bundle"].get("createUpdaterArtifacts").is_none(), "tauri.conf.json creates updater artifacts");
        let capabilities = include_str!("../capabilities/default.json");
        assert!(!capabilities.contains("updater:"), "the page was given an updater permission");
    }

    #[test]
    fn every_failure_has_a_plain_sentence_and_a_bad_signature_says_nothing_was_installed() {
        use tauri_plugin_updater::Error as E;
        assert_eq!(trouble(&E::SignatureUtf8("x".into())), Trouble::Signature);
        assert_eq!(trouble(&E::MissingSignedVersion), Trouble::Signature);
        assert_eq!(trouble(&E::SignedVersionMismatch { signed: "2.0.0".into(), announced: "9.9.9".into() }), Trouble::Signature);
        assert_eq!(trouble(&E::Network("Download request failed with status: 404".into())), Trouble::Network);
        assert_eq!(trouble(&E::ReleaseNotFound), Trouble::Network);
        assert_eq!(trouble(&E::TargetNotFound("darwin-aarch64".into())), Trouble::Release);
        assert_eq!(trouble(&E::Io(std::io::Error::other("read-only volume"))), Trouble::Install);
        assert_eq!(trouble(&E::EmptyEndpoints), Trouble::Other);

        let e = explain(E::SignatureUtf8("x".into()));
        assert_eq!(e.kind, ErrorKind::Failed);
        assert!(e.message.contains("was not installed") && e.message.contains("unchanged"), "{}", e.message);
        assert!(e.detail.is_some());
        for t in [Trouble::Network, Trouble::Release, Trouble::Signature, Trouble::Install, Trouble::Other] {
            let (_, s) = sentence(t);
            assert!(s.ends_with('.') && !s.contains("Error") && !s.contains("minisign"), "{s}");
        }
    }

    #[test]
    fn only_an_app_bundle_is_replaced() {
        let p = std::path::Path::new;
        assert!(in_app_bundle(p("/Applications/Qnet.app/Contents/MacOS/qnet")));
        assert!(!in_app_bundle(p("/build/target/debug/qnet")));
        assert!(!in_app_bundle(p("/build/Contents/MacOS/qnet")));
        assert!(!in_app_bundle(p("/Applications/Qnet.app/Contents/Resources/bin/qnet")));
    }

    #[test]
    fn the_relaunch_is_asked_about_once() {
        update_relaunch(true);
        assert!(take_relaunch());
        assert!(!take_relaunch());
        update_relaunch(true);
        update_relaunch(false);
        assert!(!take_relaunch());
    }
}
