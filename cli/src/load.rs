//! Reading a `.bnet` file for any command, with its scenarios (new in 2.1; ledger WF-503).
//!
//! A file's `nodes` hold the values of the variant it was saved showing. Every command reads its
//! file through `load`, so that: `--scenario <name|baseline>` chooses the variant for all of them
//! in one place (`qnet_core::scenarios::network_for`); every JSON document says which scenarios the
//! file has and whose values its numbers are (`scenario`, api.rs `envelope`); and a command that
//! was not told which variant to read says, as a warning, that the file was saved showing one.

use std::sync::Mutex;

use qnet_core::json::Json;
use qnet_core::model::Network;
use qnet_core::{bnet, scenarios};

pub type Failure = (u8, String);

/// What `--scenario` named, for the whole command.
static CHOICE: Mutex<Option<String>> = Mutex::new(None);
/// The scenarios of the file read last, for the document being written.
static NOTE: Mutex<Option<Note>> = Mutex::new(None);

/// A file's scenarios, as the documents report them.
#[derive(Clone, Debug, PartialEq)]
pub struct Note {
    /// The scenario the file was saved showing; None for the baseline.
    pub active: Option<String>,
    pub names: Vec<String>,
    /// Whose values the network read holds; None for the baseline.
    pub shown: Option<String>,
    /// `--scenario` chose it (so nothing needs saying).
    pub chosen: bool,
}

impl Note {
    /// The sentence for a reader that did not choose: the numbers are a scenario's, not the baseline's.
    pub fn warning(&self) -> Option<String> {
        match (&self.shown, self.chosen) {
            (Some(name), false) => Some(format!("This file was saved showing the scenario “{name}”; these numbers are that scenario's.")),
            _ => None,
        }
    }
}

pub struct Loaded {
    pub net: Network,
    /// The file's scenarios block as it stands (`bnet::read_scenarios`), whatever was chosen.
    pub scenarios: Option<Json>,
    /// The file's own network: the variant it was saved showing.
    pub as_saved: Network,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Takes `--scenario <name>` (or `--scenario=<name>`) out of the arguments and remembers it.
pub fn take_choice(args: &mut Vec<String>) -> Result<(), Failure> {
    let mut choice = None;
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--scenario" {
            if i + 1 >= args.len() {
                return Err((2, "--scenario needs a scenario's name, or “baseline”.".into()));
            }
            choice = Some(args.remove(i + 1));
            args.remove(i);
        } else if let Some(v) = args[i].strip_prefix("--scenario=") {
            choice = Some(v.to_string());
            args.remove(i);
        } else {
            i += 1;
        }
    }
    *lock(&CHOICE) = choice;
    Ok(())
}

pub fn choice() -> Option<String> {
    lock(&CHOICE).clone()
}

pub fn note() -> Option<Note> {
    lock(&NOTE).clone()
}

pub fn forget_note() {
    *lock(&NOTE) = None;
}

/// The network in `path` for the variant asked for (`which`, else `--scenario`, else as saved).
pub fn load_as(path: &str, which: Option<&str>) -> Result<Loaded, Failure> {
    let text = std::fs::read_to_string(path).map_err(|e| (1, format!("Couldn't read {path}: {e}.")))?;
    let as_saved = bnet::read(&text).map_err(|e| (1, format!("{path} isn't a network Qnet can open: {e}")))?;
    let block = bnet::read_scenarios(&text).map_err(|e| (1, format!("{path} isn't a network Qnet can open: {e}")))?;
    let (net, note) = match (&block, which) {
        (None, None) => (as_saved.clone(), None),
        (None, Some(w)) if w.trim().eq_ignore_ascii_case(scenarios::BASELINE) => (as_saved.clone(), None),
        (None, Some(w)) => return Err((1, format!("{path} has no scenarios, so there is none called “{w}”. Leave --scenario out, or give “{}”.", scenarios::BASELINE))),
        (Some(s), which) => {
            let active = scenarios::active_name(s);
            let (net, shown) = match which {
                None => (as_saved.clone(), active.clone()),
                Some(w) => {
                    let net = scenarios::network_for(&as_saved, s, w).map_err(|m| (1, m))?;
                    let id = scenarios::find(s, w).map_err(|m| (1, m))?;
                    (net, id.and_then(|id| scenarios::name_of(s, &id)))
                }
            };
            (net, Some(Note { active, names: scenarios::names(s), shown, chosen: which.is_some() }))
        }
    };
    *lock(&NOTE) = note;
    Ok(Loaded { net, scenarios: block, as_saved })
}

pub fn load(path: &str) -> Result<Loaded, Failure> {
    load_as(path, choice().as_deref())
}

/// `load`, for the commands that print text: the warning goes to stderr as one of the tool's notes.
pub fn read_saying(path: &str) -> Result<Network, Failure> {
    let loaded = load(path)?;
    if let Some(w) = note().and_then(|n| n.warning()) {
        eprintln!("qnet-cli: {w}");
    }
    Ok(loaded.net)
}
