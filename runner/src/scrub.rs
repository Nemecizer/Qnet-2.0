//! Text without this Mac's folders (the scrubber of failure reports, src-tauri/src/reports.rs,
//! moved here so `qnet-cli run --json` uses the same one; ledger WF-504): the home folder becomes
//! `~`, the temporary folder `$TMPDIR`, and a path inside the app's bundle either relative to the
//! bundle ("Contents/Resources/bin/…", a report's form) or under a name given for it
//! ("<Qnet.app>/Contents/Resources/bin/…").

use std::path::{Path, PathBuf};

/// The folders a document that leaves this Mac must not spell out.
#[derive(Clone, Debug, Default)]
pub struct Folders {
    /// `<X>.app`, when Qnet runs from a bundle.
    pub bundle: Option<PathBuf>,
    pub temp_dir: Option<PathBuf>,
    pub home: Option<PathBuf>,
}

/// How a path inside the bundle is written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bundle<'a> {
    /// Relative to the bundle: "Contents/Resources/bin/…".
    Relative,
    /// The bundle's folder under this name: "<Qnet.app>/Contents/…".
    Named(&'a str),
}

impl Folders {
    /// This process's: `bundle_resources` is the resolver's `Contents/Resources`.
    pub fn detect(bundle_resources: Option<&Path>) -> Folders {
        Folders {
            bundle: bundle_resources.and_then(|r| r.parent()).and_then(|c| c.parent()).map(Path::to_path_buf),
            temp_dir: Some(std::env::temp_dir()),
            home: std::env::var_os("HOME").filter(|h| !h.is_empty()).map(PathBuf::from),
        }
    }

    /// `text` without these folders.
    pub fn scrub(&self, text: &str, bundle: Bundle) -> String {
        let mut out = text.to_string();
        let mut swap = |dir: &Path, with: &str, keep_slash: bool| {
            let mut forms = vec![dir.to_path_buf()];
            if let Ok(real) = std::fs::canonicalize(dir) {
                forms.push(real);
            }
            if let Ok(stripped) = dir.strip_prefix("/private") {
                forms.push(Path::new("/").join(stripped));
            } else if dir.starts_with("/var") || dir.starts_with("/tmp") {
                forms.push(Path::new("/private").join(dir.strip_prefix("/").unwrap_or(dir)));
            }
            // Longest first, so "/private/var/…" goes before "/var/…".
            forms.sort_by_key(|f| std::cmp::Reverse(f.as_os_str().len()));
            forms.dedup();
            for f in forms {
                let s = f.to_string_lossy();
                let s = s.trim_end_matches('/');
                if s.is_empty() {
                    continue;
                }
                if keep_slash {
                    out = replace_folder(&out, s, with);
                } else {
                    out = out.replace(&format!("{s}/"), with);
                }
            }
        };
        if let Some(b) = &self.bundle {
            match bundle {
                Bundle::Relative => swap(b, "", false),
                Bundle::Named(name) => swap(b, name, true),
            }
        }
        if let Some(t) = &self.temp_dir {
            swap(t, "$TMPDIR", true);
        }
        if let Some(h) = &self.home {
            swap(h, "~", true);
        }
        out
    }
}

/// `text` with the folder `dir` replaced by `with` wherever `dir` is a whole path prefix: where
/// the folder's name ends there. "/Users/ann" is replaced in "/Users/ann/x" and in "/Users/ann",
/// not in "/Users/anna/x" (another folder). A name goes on through letters, digits, `_`, `-`, and
/// a `.` that a letter or digit follows ("/Users/ann.old"), so "/Users/ann." ending a sentence is
/// still replaced.
fn replace_folder(text: &str, dir: &str, with: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(dir) {
        let after = &rest[at + dir.len()..];
        let mut next = after.chars();
        let goes_on = match next.next() {
            Some(c) if c.is_alphanumeric() || c == '_' || c == '-' => true,
            Some('.') => next.next().is_some_and(char::is_alphanumeric),
            _ => false,
        };
        out.push_str(&rest[..at]);
        out.push_str(if goes_on { dir } else { with });
        rest = after;
    }
    out.push_str(rest);
    out
}


#[cfg(test)]
mod tests {
    use super::*;

    fn folders() -> Folders {
        Folders { bundle: Some("/Applications/Qnet.app".into()), temp_dir: Some("/var/folders/ab/T".into()), home: Some("/Users/ann".into()) }
    }

    #[test]
    fn the_home_the_temporary_folder_and_the_bundle_are_not_spelled_out() {
        let f = folders();
        let text = "bundled solver: /Applications/Qnet.app/Contents/Resources/bin/qna; Python runtime: /Users/ann/Library/Caches/qnet/python/bin/python3 (/private/var/folders/ab/T/x.json)";
        assert_eq!(f.scrub(text, Bundle::Named("<Qnet.app>")), "bundled solver: <Qnet.app>/Contents/Resources/bin/qna; Python runtime: ~/Library/Caches/qnet/python/bin/python3 ($TMPDIR/x.json)");
        assert_eq!(f.scrub(text, Bundle::Relative), "bundled solver: Contents/Resources/bin/qna; Python runtime: ~/Library/Caches/qnet/python/bin/python3 ($TMPDIR/x.json)");
    }

    #[test]
    fn another_folder_with_a_longer_name_is_left_alone() {
        let f = folders();
        assert_eq!(f.scrub("/Users/anna/x and /Users/ann.old/y, but /Users/ann.", Bundle::Relative), "/Users/anna/x and /Users/ann.old/y, but ~.");
        assert_eq!(f.scrub("/Applications/Qnet.app2/x", Bundle::Named("<Qnet.app>")), "/Applications/Qnet.app2/x");
        // An app in the home folder: the bundle is named first, so the home folder is not left in it.
        let own = Folders { bundle: Some("/Users/ann/Applications/Qnet.app".into()), ..folders() };
        assert_eq!(own.scrub("/Users/ann/Applications/Qnet.app/Contents/MacOS/qnet-cli", Bundle::Named("<Qnet.app>")), "<Qnet.app>/Contents/MacOS/qnet-cli");
    }
}
