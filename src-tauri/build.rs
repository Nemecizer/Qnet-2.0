fn main() {
    build_tag();
    tauri_build::build()
}

/// QNET_BUILD_TAG: `git describe --tags --always --dirty` of the tree this was built from, else
/// "untagged". About and the candidate's provenance name it, so a build says what it was made from.
///
/// The tree is the one cargo builds now (CARGO_MANIFEST_DIR read when the script runs, not when it
/// was compiled): two checkouts that share a target folder share this script's binary.
fn build_tag() {
    let manifest = std::env::var_os("CARGO_MANIFEST_DIR").map(std::path::PathBuf::from).unwrap_or_default();
    let root = manifest.join("..");
    let git = root.join(".git");
    let mut watched = vec![git.join("HEAD"), git.join("refs"), git.join("packed-refs")];
    // The branch HEAD points to moves with every commit.
    if let Some(r) = std::fs::read_to_string(git.join("HEAD")).ok().and_then(|h| h.strip_prefix("ref: ").map(|r| r.trim().to_string())) {
        watched.push(git.join(r));
    }
    for p in watched.iter().filter(|p| p.exists()) {
        println!("cargo:rerun-if-changed={}", p.display());
    }
    let tag = std::process::Command::new("git")
        .args(["describe", "--tags", "--always", "--dirty"])
        .current_dir(&root)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|t| !t.is_empty() && t.chars().all(|c| c.is_ascii_alphanumeric() || "-._+".contains(c)))
        .unwrap_or_else(|| "untagged".into());
    println!("cargo:rustc-env=QNET_BUILD_TAG={tag}");
}
