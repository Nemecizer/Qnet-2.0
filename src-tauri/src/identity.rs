//! Which Qnet this is.
//!
//! The release app is `com.nemecj.qnet`; a debug build is `com.nemecj.qnet.dev`. Tauri names the
//! config and data folders after the identifier, so a development run never reads or writes the
//! release app's settings, open tabs or results. Both differ from Qnet 0.90.34 (`com.bnetgui.app`),
//! so the old and the new app run side by side during the port (PLAN.md D4).

pub const RELEASE_ID: &str = "com.nemecj.qnet";
pub const DEV_ID: &str = "com.nemecj.qnet.dev";

/// The identifier for a debug or a release build.
pub fn identifier_for(debug: bool) -> &'static str {
    if debug {
        DEV_ID
    } else {
        RELEASE_ID
    }
}

/// This build's bundle identifier.
pub fn identifier() -> &'static str {
    identifier_for(cfg!(debug_assertions))
}

/// "release" or "dev", as About and the logs name it.
pub fn instance_name() -> &'static str {
    if cfg!(debug_assertions) {
        "dev"
    } else {
        "release"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_debug_build_keeps_its_files_apart_from_the_release_app() {
        assert_eq!(identifier_for(false), "com.nemecj.qnet");
        assert_eq!(identifier_for(true), "com.nemecj.qnet.dev");
        assert!(DEV_ID.starts_with(RELEASE_ID));
    }

    /// tauri.conf.json carries the release identifier; `run` overrides it only for debug builds.
    #[test]
    fn the_bundle_config_names_the_release_identifier() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], RELEASE_ID);
        assert_eq!(conf["version"], env!("CARGO_PKG_VERSION"), "tauri.conf.json and Cargo.toml give one version");
    }
}
