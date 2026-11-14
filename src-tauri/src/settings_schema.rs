//! What each setting holds: 0.90.34's `AppSettings.defaultsByKey`, `rangesByKey`,
//! `allowedNumbersByKey` and `allowedStringsByKey` (AppSettings.swift), under the same key names,
//! so a settings file exported from 0.90.34 imports unchanged (PLAN.md §4, ledger INV-082).
//!
//! `KEYS` is every one of the 108 keys (then the keys 2.1 added, at the end), in the order of `defaultsByKey`'s literal, with the three
//! per-provider families (`ai.baseURL.<p>`, `ai.model.<p>`, `ai.discovered.<p>`) added after it
//! provider by provider, as its `for p in LLMProvider.allCases` loop adds them. Kinds follow the
//! Swift type of each `Defaults` constant. `rejection` is 0.90.34's `validateImported`, with its
//! reasons word for word (ledger FILE-052); `validate` turns the same checks into the sentence a
//! refused settings patch shows.

use serde_json::{json, Map, Value};

/// The kind of value a key stores; JSON `true`/`false` is only ever a Bool (0.90.34 checked
/// `CFBooleanGetTypeID` before reading a number).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Bool,
    Int,
    Double,
    Text,
}

/// The bounds of a numeric key (0.90.34 `rangesByKey`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Bounds {
    None,
    /// Inclusive.
    Fixed(f64, f64),
    /// `0…max(1, logical cores)`: 0.90.34's `Ranges.exactSimThreads`, which depends on the Mac
    /// that imports the file (ledger SET-081).
    Cores,
}

pub struct Key {
    pub name: &'static str,
    pub kind: Kind,
    pub default: fn() -> Value,
    pub bounds: Bounds,
    /// The only numbers the key takes (0.90.34 `allowedNumbersByKey`: pop-up tags and γ).
    pub allowed_numbers: &'static [f64],
    /// The only strings the key takes (0.90.34 `allowedStringsByKey`).
    pub allowed_strings: &'static [&'static str],
}

impl Key {
    /// The inclusive range the key's numbers must lie in, if it has one.
    pub fn range(&self) -> Option<(f64, f64)> {
        match self.bounds {
            Bounds::None => None,
            Bounds::Fixed(lo, hi) => Some((lo, hi)),
            Bounds::Cores => Some((0.0, logical_cores().max(1) as f64)),
        }
    }
}

/// `ProcessInfo.activeProcessorCount`.
pub fn logical_cores() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1)
}

const fn key(name: &'static str, kind: Kind, default: fn() -> Value) -> Key {
    Key { name, kind, default, bounds: Bounds::None, allowed_numbers: &[], allowed_strings: &[] }
}
const fn int(name: &'static str, default: fn() -> Value, lo: f64, hi: f64) -> Key {
    Key { bounds: Bounds::Fixed(lo, hi), ..key(name, Kind::Int, default) }
}
const fn dbl(name: &'static str, default: fn() -> Value, lo: f64, hi: f64) -> Key {
    Key { bounds: Bounds::Fixed(lo, hi), ..key(name, Kind::Double, default) }
}
const fn choice(name: &'static str, default: fn() -> Value, allowed: &'static [f64]) -> Key {
    Key { allowed_numbers: allowed, ..key(name, Kind::Int, default) }
}
const fn flag(name: &'static str, default: fn() -> Value) -> Key {
    key(name, Kind::Bool, default)
}
const fn text(name: &'static str, default: fn() -> Value) -> Key {
    key(name, Kind::Text, default)
}

// AppSettings.Choices.
const ENGINE: &[f64] = &[0.0, 1.0];
const THREE: &[f64] = &[0.0, 1.0, 2.0];
const TWO: &[f64] = &[0.0, 1.0];
const GAMMA: &[f64] = &[0.01, 0.05, 0.1, 0.25, 0.5];
const FOUR: &[f64] = &[0.0, 1.0, 2.0, 3.0];
/// `RandomNetworkGenerator.Topology.allCases`.
const TOPOLOGY: &[f64] = &[0.0, 1.0, 2.0, 3.0];
/// `HelpOutputDestination.allCases`.
const HELP_DESTINATION: &[f64] = &[0.0, 1.0, 2.0];
/// `LLMProvider.allCases`.
pub const PROVIDERS: &[&str] = &["anthropic", "openai", "ollama", "lmstudio"];
/// `[""] + FocusRouter.Pane.allCases`.
pub const SOLO_PANES: &[&str] = &["", "palette", "canvas", "status", "results", "shell", "ai", "inspector"];

// AppSettings.Ranges.
const I32_MAX: f64 = 2_147_483_647.0;
const FONT: (f64, f64) = (8.0, 28.0);

/// The system prompt a fresh install sends (`Defaults.aiSystemPrompt`).
pub const DEFAULT_SYSTEM_PROMPT: &str =
    "You are an assistant embedded in BNET, a tool for Brownian Network analysis of queueing systems. Answer concisely.";

/// Every key, in 0.90.34's `defaultsByKey` order.
pub static KEYS: &[Key] = &[
    choice("engine.regenerative", || json!(0), ENGINE),
    choice("engine.qbd", || json!(0), ENGINE),
    choice("engine.ctmc", || json!(0), ENGINE),
    int("sim.replications", || json!(50), 1.0, 10_000.0),
    int("sim.warmup", || json!(1_000_000), 0.0, 1_000_000_000.0),
    int("sim.time", || json!(5_000_000), 1.0, 1_000_000_000.0),
    choice("sim.parallel", || json!(0), THREE),
    choice("sim.blocking", || json!(2), THREE),
    flag("sim.seedFixed", || json!(false)),
    int("sim.seed", || json!(12_345), 0.0, I32_MAX),
    choice("fem.solver", || json!(0), TWO),
    int("fem.meshSize", || json!(10), 2.0, 20.0),
    int("sm.degree", || json!(8), 2.0, 30.0),
    flag("sm.legendre", || json!(false)),
    dbl("mlmc.epsilon", || json!(0.01), 1e-4, 1.0),
    Key { allowed_numbers: GAMMA, ..key("mlmc.gamma", Kind::Double, || json!(0.05)) },
    flag("mlmc.overrideT", || json!(false)),
    dbl("mlmc.T", || json!(10.0), 0.01, 10_000.0),
    flag("mlmc.overrideL", || json!(false)),
    int("mlmc.L", || json!(3), 1.0, 20.0),
    flag("mlmc.overrideN", || json!(false)),
    int("mlmc.N", || json!(25_000), 100.0, 100_000_000.0),
    choice("mlmc.backend", || json!(0), FOUR),
    Key { bounds: Bounds::Cores, ..key("mlmc.threads", Kind::Int, || json!(0)) },
    flag("mlmc.seedFixed", || json!(false)),
    int("mlmc.seed", || json!(12_345), 0.0, I32_MAX),
    flag("mlmc.antithetic", || json!(false)),
    flag("mlmc.adaptive", || json!(false)),
    int("mlmc.batchSize", || json!(1_000), 1.0, 10_000_000.0),
    int("mlmc.minSamples", || json!(5_000), 2.0, 100_000_000.0),
    int("mlmc.maxSamples", || json!(200_000), 2.0, 100_000_000.0),
    int("mlmc.replications", || json!(1), 1.0, 1_000.0),
    // A stored 0 on the LP grid / basis keys means "auto", so they admit 0 below the field's own
    // minimum (AppSettings.rangesByKey).
    int("lp.gridN", || json!(0), 0.0, 1_000.0),
    int("lp.basisM", || json!(0), 0.0, 64.0),
    choice("lp.solver", || json!(0), FOUR),
    choice("lp.gridType", || json!(0), THREE),
    dbl("lp.smoothness", || json!(0.0), 0.0, 1.0),
    flag("lp.basisNormalize", || json!(false)),
    flag("lp.askBeforeRun", || json!(false)),
    flag("lp.multiLevel", || json!(false)),
    int("flp.gridN", || json!(0), 0.0, 1_000.0),
    int("flp.basisM", || json!(0), 0.0, 64.0),
    choice("flp.solver", || json!(0), THREE),
    choice("flp.gridType", || json!(0), TWO),
    flag("flp.basisNormalize", || json!(false)),
    flag("flp.askBeforeRun", || json!(false)),
    int("testset.inf.stationsLo", || json!(3), 1.0, 12.0),
    int("testset.inf.stationsHi", || json!(6), 1.0, 12.0),
    int("testset.inf.classesLo", || json!(1), 1.0, 8.0),
    int("testset.inf.classesHi", || json!(3), 1.0, 8.0),
    dbl("testset.inf.rhoLo", || json!(0.5), 0.01, 0.99),
    dbl("testset.inf.rhoHi", || json!(0.85), 0.01, 0.99),
    int("testset.inf.numCases", || json!(20), 1.0, 1_000.0),
    choice("testset.inf.topology", || json!(0), TOPOLOGY),
    int("testset.fin.stationsLo", || json!(2), 1.0, 12.0),
    int("testset.fin.stationsHi", || json!(4), 1.0, 12.0),
    int("testset.fin.classesLo", || json!(1), 1.0, 8.0),
    int("testset.fin.classesHi", || json!(2), 1.0, 8.0),
    dbl("testset.fin.rhoLo", || json!(0.5), 0.01, 0.99),
    dbl("testset.fin.rhoHi", || json!(0.85), 0.01, 0.99),
    int("testset.fin.numCases", || json!(10), 1.0, 1_000.0),
    choice("testset.fin.topology", || json!(0), TOPOLOGY),
    int("testset.spc.stationsLo", || json!(3), 1.0, 12.0),
    int("testset.spc.stationsHi", || json!(6), 1.0, 12.0),
    int("testset.spc.classesLo", || json!(1), 1.0, 8.0),
    int("testset.spc.classesHi", || json!(3), 1.0, 8.0),
    dbl("testset.spc.rhoStart", || json!(0.50), 0.01, 0.99),
    dbl("testset.spc.rhoEnd", || json!(0.95), 0.01, 0.99),
    dbl("testset.spc.rhoStep", || json!(0.05), 0.01, 0.5),
    int("testset.spc.numCases", || json!(10), 1.0, 1_000.0),
    choice("testset.spc.topology", || json!(0), TOPOLOGY),
    choice("tabs.restoreBehavior", || json!(0), THREE),
    flag("runCompare.remember", || json!(false)),
    flag("gcdg.enabled", || json!(false)),
    dbl("shell.fontSize", || json!(12.0), FONT.0, FONT.1),
    text("shell.fontName", || json!("")),
    flag("shell.classicTheme", || json!(false)),
    flag("palette.paneVisible", || json!(true)),
    flag("status.paneVisible", || json!(true)),
    flag("results.paneVisible", || json!(false)),
    flag("shell.paneVisible", || json!(true)),
    flag("inspector.paneVisible", || json!(true)),
    flag("results.autoShown", || json!(false)),
    Key { allowed_strings: SOLO_PANES, ..text("panes.soloed", || json!("")) },
    // A comma-joined *set* of panes: free text on import, sanitised by its reader (AppSettings.swift).
    text("panes.detached", || json!("")),
    dbl("status.fontSize", || json!(12.0), FONT.0, FONT.1),
    int("output.decimals", || json!(6), 0.0, 6.0),
    choice("help.outputDestination", || json!(2), HELP_DESTINATION),
    Key { allowed_strings: PROVIDERS, ..text("ai.provider", || json!("anthropic")) },
    text("ai.systemPrompt", || json!(DEFAULT_SYSTEM_PROMPT)),
    int("ai.maxTokens", || json!(4096), 1.0, 200_000.0),
    dbl("ai.temperature", || json!(0.7), 0.0, 2.0),
    dbl("ai.timeoutSec", || json!(60.0), 1.0, 600.0),
    flag("ai.paneVisible", || json!(false)),
    dbl("ai.fontSize", || json!(12.0), FONT.0, FONT.1),
    text("ai.fontName", || json!("")),
    // `for p in LLMProvider.allCases`: defaultBaseURL, defaultModel, "" (LLMBackend.swift).
    text("ai.baseURL.anthropic", || json!("https://api.anthropic.com")),
    text("ai.model.anthropic", || json!("claude-opus-5-5")),
    text("ai.discovered.anthropic", || json!("")),
    text("ai.baseURL.openai", || json!("https://api.openai.com/v1")),
    text("ai.model.openai", || json!("gpt-6-astra")),
    text("ai.discovered.openai", || json!("")),
    text("ai.baseURL.ollama", || json!("http://localhost:11434")),
    text("ai.model.ollama", || json!("llama3.2")),
    text("ai.discovered.ollama", || json!("")),
    text("ai.baseURL.lmstudio", || json!("http://localhost:1234/v1")),
    text("ai.model.lmstudio", || json!("local-model")),
    text("ai.discovered.lmstudio", || json!("")),
    // New in 2.1 (not in 0.90.34's table; an imported 0.90.34 file simply lacks them).
    flag("welcome.showAtLaunch", || json!(true)),
    // Settings ▸ General ▸ Updates: read only by a build configured to update (updates.rs).
    flag("updates.auto", || json!(true)),
    // Settings ▸ AI Assistant: "If Claude declines, let another Claude model answer" (ai/wire.rs
    // `anthropic_fallback_applies`, ledger AI-205).
    flag("ai.fallback.anthropic", || json!(true)),
];

pub fn find(name: &str) -> Option<&'static Key> {
    KEYS.iter().find(|k| k.name == name)
}

/// `stored` with every missing key filled in from its default. Stored keys the table doesn't
/// know are left out.
pub fn with_defaults(stored: &Map<String, Value>) -> Map<String, Value> {
    KEYS.iter().map(|k| (k.name.to_string(), stored.get(k.name).cloned().unwrap_or_else(k.default))).collect()
}

/// Why an imported value was refused (0.90.34 `AppSettings.ImportRejection`).
#[derive(Clone, Debug, PartialEq)]
pub enum Rejection {
    UnknownKey,
    WrongType(&'static str),
    OutOfRange(f64, f64),
    /// The key is an enumeration and the value is none of the options the pane offers.
    NotOneOf(Vec<String>),
}

impl Rejection {
    /// 0.90.34's `ImportRejection.description`, word for word.
    pub fn description(&self) -> String {
        match self {
            Rejection::UnknownKey => "not a Qnet setting".into(),
            Rejection::WrongType(expected) => format!("expected {expected}"),
            Rejection::OutOfRange(lo, hi) => format!("outside {}…{}", sig4(*lo), sig4(*hi)),
            Rejection::NotOneOf(allowed) => format!("not one of {}", allowed.join(", ")),
        }
    }
}

/// `DS.Number.format(v, significantDigits: 4)`: at most four significant digits, en-US grouping
/// (`2,147,000,000`, `0.0001`, `10,000`).
pub fn sig4(v: f64) -> String {
    if !v.is_finite() {
        return if v.is_nan() { "—".into() } else { "∞".into() };
    }
    if v == 0.0 {
        return "0".into();
    }
    let e = v.abs().log10().floor() as i32;
    let decimals = (3 - e).max(0) as usize;
    let rounded = if e > 3 {
        let unit = 10f64.powi(e - 3);
        (v / unit).round() * unit
    } else {
        v
    };
    let mut s = format!("{rounded:.decimals$}");
    if s.contains('.') {
        s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    }
    let (sign, body) = s.strip_prefix('-').map(|b| ("-", b)).unwrap_or(("", s.as_str()));
    let (whole, frac) = body.split_once('.').map(|(w, f)| (w, Some(f))).unwrap_or((body, None));
    let mut grouped = String::new();
    for (i, c) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    match frac {
        Some(f) => format!("{sign}{grouped}.{f}"),
        None => format!("{sign}{grouped}"),
    }
}

/// 0.90.34's `validateImported`: why `value` can't be stored under `name`, or None.
pub fn rejection(name: &str, value: &Value) -> Option<Rejection> {
    let Some(k) = find(name) else { return Some(Rejection::UnknownKey) };
    match k.kind {
        Kind::Bool => (!value.is_boolean()).then_some(Rejection::WrongType("true or false")),
        Kind::Text => {
            let Some(s) = value.as_str() else { return Some(Rejection::WrongType("text")) };
            if !k.allowed_strings.is_empty() && !k.allowed_strings.contains(&s) {
                return Some(Rejection::NotOneOf(k.allowed_strings.iter().map(|s| s.to_string()).collect()));
            }
            None
        }
        Kind::Int | Kind::Double => {
            let Some(d) = value.as_f64() else {
                return Some(Rejection::WrongType(if k.kind == Kind::Int { "a whole number" } else { "a number" }));
            };
            if !d.is_finite() {
                return Some(Rejection::WrongType("a finite number"));
            }
            if k.kind == Kind::Int && d.round() != d {
                return Some(Rejection::WrongType("a whole number"));
            }
            if !k.allowed_numbers.is_empty() {
                if !k.allowed_numbers.iter().any(|a| (a - d).abs() <= 1e-9) {
                    return Some(Rejection::NotOneOf(k.allowed_numbers.iter().map(|a| sig4(*a)).collect()));
                }
                return None;
            }
            match k.range() {
                Some((lo, hi)) if d < lo || d > hi => Some(Rejection::OutOfRange(lo, hi)),
                _ => None,
            }
        }
    }
}

/// Why `value` can't be stored under `name`, as a sentence naming the key, or Ok. The same
/// checks as an import (`rejection`), so the window can never store what Import would refuse.
pub fn validate(name: &str, value: &Value) -> Result<(), String> {
    match rejection(name, value) {
        None => Ok(()),
        Some(Rejection::UnknownKey) => Err(format!("There's no setting called “{name}”.")),
        Some(Rejection::WrongType(expected)) => Err(format!("The setting “{name}” takes {expected}.")),
        Some(Rejection::OutOfRange(lo, hi)) => Err(format!("The setting “{name}” takes a value from {} to {}.", sig4(lo), sig4(hi))),
        Some(Rejection::NotOneOf(_)) => Err(match value.as_str() {
            Some(s) => format!("The setting “{name}” doesn't take “{s}”."),
            None => format!("The setting “{name}” doesn't take {value}."),
        }),
    }
}

/// The table as the interface reads it (`settings_schema_get`): name, kind, default, range and
/// allowed values per key, in order.
pub fn describe() -> Vec<Value> {
    KEYS.iter()
        .map(|k| {
            let kind = match k.kind {
                Kind::Bool => "bool",
                Kind::Int => "int",
                Kind::Double => "double",
                Kind::Text => "text",
            };
            json!({
                "name": k.name,
                "kind": kind,
                "default": (k.default)(),
                "range": k.range().map(|(lo, hi)| json!([lo, hi])),
                "allowedNumbers": k.allowed_numbers,
                "allowedStrings": k.allowed_strings,
            })
        })
        .collect()
}

/// Every key with its kind, default, range and allowed values (src/windows/settings reads it).
#[tauri::command]
pub fn settings_schema_get() -> Vec<Value> {
    describe()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 0.90.34's `defaultsByKey` literal, key by key, in its order, then the provider families.
    const ORDER_0_90_34: &[&str] = &[
        "engine.regenerative", "engine.qbd", "engine.ctmc", "sim.replications", "sim.warmup", "sim.time",
        "sim.parallel", "sim.blocking", "sim.seedFixed", "sim.seed", "fem.solver", "fem.meshSize", "sm.degree",
        "sm.legendre", "mlmc.epsilon", "mlmc.gamma", "mlmc.overrideT", "mlmc.T", "mlmc.overrideL", "mlmc.L",
        "mlmc.overrideN", "mlmc.N", "mlmc.backend", "mlmc.threads", "mlmc.seedFixed", "mlmc.seed",
        "mlmc.antithetic", "mlmc.adaptive", "mlmc.batchSize", "mlmc.minSamples", "mlmc.maxSamples",
        "mlmc.replications", "lp.gridN", "lp.basisM", "lp.solver", "lp.gridType", "lp.smoothness",
        "lp.basisNormalize", "lp.askBeforeRun", "lp.multiLevel", "flp.gridN", "flp.basisM", "flp.solver",
        "flp.gridType", "flp.basisNormalize", "flp.askBeforeRun", "testset.inf.stationsLo",
        "testset.inf.stationsHi", "testset.inf.classesLo", "testset.inf.classesHi", "testset.inf.rhoLo",
        "testset.inf.rhoHi", "testset.inf.numCases", "testset.inf.topology", "testset.fin.stationsLo",
        "testset.fin.stationsHi", "testset.fin.classesLo", "testset.fin.classesHi", "testset.fin.rhoLo",
        "testset.fin.rhoHi", "testset.fin.numCases", "testset.fin.topology", "testset.spc.stationsLo",
        "testset.spc.stationsHi", "testset.spc.classesLo", "testset.spc.classesHi", "testset.spc.rhoStart",
        "testset.spc.rhoEnd", "testset.spc.rhoStep", "testset.spc.numCases", "testset.spc.topology",
        "tabs.restoreBehavior", "runCompare.remember", "gcdg.enabled", "shell.fontSize", "shell.fontName",
        "shell.classicTheme", "palette.paneVisible", "status.paneVisible", "results.paneVisible",
        "shell.paneVisible", "inspector.paneVisible", "results.autoShown", "panes.soloed", "panes.detached",
        "status.fontSize", "output.decimals", "help.outputDestination", "ai.provider", "ai.systemPrompt",
        "ai.maxTokens", "ai.temperature", "ai.timeoutSec", "ai.paneVisible", "ai.fontSize", "ai.fontName",
    ];

    #[test]
    fn the_table_is_0_90_34s_108_keys_in_its_order() {
        assert_eq!(ORDER_0_90_34.len(), 96);
        let mut expected: Vec<String> = ORDER_0_90_34.iter().map(|s| s.to_string()).collect();
        for p in PROVIDERS {
            expected.push(format!("ai.baseURL.{p}"));
            expected.push(format!("ai.model.{p}"));
            expected.push(format!("ai.discovered.{p}"));
        }
        let names: Vec<String> = KEYS.iter().map(|k| k.name.to_string()).collect();
        assert_eq!(expected.len(), 108);
        assert_eq!(&names[..108], &expected[..]);
        // Keys added since (2.1) follow the 108, and none reuses a 0.90.34 name.
        assert!(names[108..].iter().all(|n| !expected.contains(n)), "{:?}", &names[108..]);
        assert!(names[108..].contains(&"welcome.showAtLaunch".to_string()));
        assert!(names[108..].contains(&"updates.auto".to_string()));
    }

    /// 0.90.34's `SettingsRegistry.auditImportTables` (ledger SET-220, CLI-002): every numeric key
    /// is bounded by exactly one of the range and choice tables, Int keys have whole bounds, every
    /// default satisfies its own bound, and Bool keys default to a Bool.
    #[test]
    fn the_import_tables_bound_every_key_and_every_default_fits() {
        let mut problems = vec![];
        for k in KEYS {
            let d = (k.default)();
            match k.kind {
                Kind::Bool => {
                    if !d.is_boolean() {
                        problems.push(format!("{}: default is not a Bool", k.name));
                    }
                    if k.bounds != Bounds::None || !k.allowed_numbers.is_empty() || !k.allowed_strings.is_empty() {
                        problems.push(format!("{}: a Bool key with bounds", k.name));
                    }
                }
                Kind::Text => {
                    let s = d.as_str().unwrap_or_else(|| panic!("{}: default is not text", k.name));
                    if !k.allowed_strings.is_empty() && !k.allowed_strings.contains(&s) {
                        problems.push(format!("{}: default “{s}” is not one of its allowed values", k.name));
                    }
                    if k.bounds != Bounds::None || !k.allowed_numbers.is_empty() {
                        problems.push(format!("{}: a text key with numeric bounds", k.name));
                    }
                }
                Kind::Int | Kind::Double => {
                    let v = d.as_f64().unwrap_or_else(|| panic!("{}: default is not a number", k.name));
                    if (k.bounds != Bounds::None) == !k.allowed_numbers.is_empty() {
                        problems.push(format!("{}: numeric key must be bounded by exactly one of the range and choice tables", k.name));
                    }
                    if let Some((lo, hi)) = k.range() {
                        if !(lo <= hi && lo.is_finite() && hi.is_finite()) {
                            problems.push(format!("{}: range is not finite and ordered", k.name));
                        }
                        if k.kind == Kind::Int && (lo.round() != lo || hi.round() != hi) {
                            problems.push(format!("{}: Int key with non-integral bounds", k.name));
                        }
                        if v < lo || v > hi {
                            problems.push(format!("{}: default {v} lies outside {lo}…{hi}", k.name));
                        }
                    }
                    if !k.allowed_numbers.is_empty() && !k.allowed_numbers.iter().any(|a| (a - v).abs() <= 1e-9) {
                        problems.push(format!("{}: default {v} is not one of its menu options", k.name));
                    }
                    if k.kind == Kind::Int && !d.is_i64() {
                        problems.push(format!("{}: Int default is not written as a whole number", k.name));
                    }
                }
            }
            if let Err(e) = validate(k.name, &d) {
                problems.push(e);
            }
        }
        assert!(problems.is_empty(), "{problems:#?}");
    }

    #[test]
    fn values_are_checked_for_type_range_and_choice() {
        assert!(validate("status.paneVisible", &json!(1)).unwrap_err().contains("true or false"));
        assert!(validate("tabs.restoreBehavior", &json!(3)).is_err());
        assert!(validate("tabs.restoreBehavior", &json!(1.5)).is_err());
        assert!(validate("tabs.restoreBehavior", &json!(2)).is_ok());
        assert!(validate("status.fontSize", &json!(40)).unwrap_err().contains("8 to 28"));
        assert!(validate("no.such", &json!(1)).unwrap_err().contains("no.such"));
        assert_eq!(validate("ai.provider", &json!("gemini")).unwrap_err(), "The setting “ai.provider” doesn't take “gemini”.");
        assert_eq!(validate("sim.seed", &json!(-1)).unwrap_err(), "The setting “sim.seed” takes a value from 0 to 2,147,000,000.");
        // An Int key takes a whole number written with a fraction (JSON 10.0), as 0.90.34 did.
        assert!(validate("sim.replications", &json!(10.0)).is_ok());
        assert!(validate("mlmc.gamma", &json!(0.05000000001)).is_ok());
    }

    /// The reasons of ledger FILE-052, as 0.90.34 words them.
    #[test]
    fn import_rejections_read_as_0_90_34s() {
        let r = |k: &str, v: Value| rejection(k, &v).map(|r| r.description());
        assert_eq!(r("gcdg.enable", json!(true)).as_deref(), Some("not a Qnet setting"));
        assert_eq!(r("sm.legendre", json!(1)).as_deref(), Some("expected true or false"));
        assert_eq!(r("shell.fontName", json!(3)).as_deref(), Some("expected text"));
        assert_eq!(r("sim.replications", json!("50")).as_deref(), Some("expected a whole number"));
        assert_eq!(r("sim.replications", json!(true)).as_deref(), Some("expected a whole number"));
        assert_eq!(r("sim.replications", json!(12.5)).as_deref(), Some("expected a whole number"));
        assert_eq!(r("mlmc.epsilon", json!("0.01")).as_deref(), Some("expected a number"));
        assert_eq!(r("sim.replications", json!(0)).as_deref(), Some("outside 1…10,000"));
        assert_eq!(r("sim.seed", json!(-5)).as_deref(), Some("outside 0…2,147,000,000"));
        assert_eq!(r("sim.warmup", json!(2e9)).as_deref(), Some("outside 0…1,000,000,000"));
        assert_eq!(r("mlmc.epsilon", json!(2)).as_deref(), Some("outside 0.0001…1"));
        assert_eq!(r("mlmc.T", json!(0.001)).as_deref(), Some("outside 0.01…10,000"));
        assert_eq!(r("mlmc.gamma", json!(0.2)).as_deref(), Some("not one of 0.01, 0.05, 0.1, 0.25, 0.5"));
        assert_eq!(r("lp.solver", json!(4)).as_deref(), Some("not one of 0, 1, 2, 3"));
        assert_eq!(r("ai.provider", json!("gemini")).as_deref(), Some("not one of anthropic, openai, ollama, lmstudio"));
        assert_eq!(r("panes.soloed", json!("canvasx")).as_deref(), Some("not one of , palette, canvas, status, results, shell, ai, inspector"));
        assert_eq!(r("panes.detached", json!("anything,at all")), None);
        assert_eq!(r("mlmc.threads", json!(logical_cores().max(1) + 1)).as_deref(), Some(format!("outside 0…{}", sig4(logical_cores().max(1) as f64)).as_str()));
        assert_eq!(r("mlmc.threads", json!(1)), None);
    }

    #[test]
    fn four_significant_digits_with_grouping() {
        assert_eq!(sig4(0.0), "0");
        assert_eq!(sig4(1.0), "1");
        assert_eq!(sig4(0.0001), "0.0001");
        assert_eq!(sig4(0.05), "0.05");
        assert_eq!(sig4(0.99), "0.99");
        assert_eq!(sig4(28.0), "28");
        assert_eq!(sig4(10_000.0), "10,000");
        assert_eq!(sig4(200_000.0), "200,000");
        assert_eq!(sig4(2_147_483_647.0), "2,147,000,000");
        // FormatStyle rounds half to even, as Rust's formatting does.
        assert_eq!(sig4(1234.5), "1,234");
        assert_eq!(sig4(1235.5), "1,236");
        assert_eq!(sig4(0.123456), "0.1235");
    }

    /// The browser preview's copy (src/dev/mock/kv.ts) has the same keys, in the same order,
    /// with the same defaults, kinds, ranges and choices as this table.
    #[test]
    fn the_preview_mock_mirrors_the_schema() {
        let ts = include_str!("../../src/dev/mock/kv.ts");
        let block = |name: &str| -> Vec<(String, Value)> {
            let start = ts.find(&format!("export const {name}")).unwrap_or_else(|| panic!("no {name} in kv.ts"));
            let body = &ts[start..];
            let body = &body[body.find('{').unwrap() + 1..body.find("\n};").unwrap()];
            body.lines()
                .map(str::trim)
                .filter(|l| l.starts_with('"'))
                .map(|l| {
                    let (k, v) = l.split_once("\": ").unwrap_or_else(|| panic!("can't read the line {l}"));
                    let v = v.trim_end_matches(',');
                    (k.trim_start_matches('"').to_string(), serde_json::from_str(v).unwrap_or_else(|e| panic!("{k}: {v}: {e}")))
                })
                .collect()
        };
        let defaults = block("SETTINGS_DEFAULTS");
        let rules = block("SETTINGS_RULES");
        let names: Vec<&str> = KEYS.iter().map(|k| k.name).collect();
        assert_eq!(defaults.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), names, "SETTINGS_DEFAULTS keys or order");
        assert_eq!(rules.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), names, "SETTINGS_RULES keys or order");
        for ((k, d), (_, rule)) in defaults.iter().zip(&rules) {
            let key = find(k).unwrap();
            let want = (key.default)();
            let same = match (d.as_f64(), want.as_f64()) {
                (Some(a), Some(b)) => a == b,
                _ => *d == want,
            };
            assert!(same, "{k}: the mock's default {d} is not {want}");
            let kind = match key.kind {
                Kind::Bool => "bool",
                Kind::Int => "int",
                Kind::Double => "double",
                Kind::Text => "text",
            };
            assert_eq!(rule["kind"], json!(kind), "{k}: kind");
            let range = match key.bounds {
                Bounds::None => Value::Null,
                Bounds::Fixed(lo, hi) => json!([lo, hi]),
                Bounds::Cores => json!([0.0, "cores"]),
            };
            let mock_range = match &rule["range"] {
                Value::Array(a) => Value::Array(a.iter().map(|x| x.as_f64().map(|f| json!(f)).unwrap_or(x.clone())).collect()),
                v => v.clone(),
            };
            assert_eq!(mock_range, range, "{k}: range");
            let nums: Vec<f64> = rule["choices"].as_array().map(|a| a.iter().filter_map(Value::as_f64).collect()).unwrap_or_default();
            assert_eq!(nums, key.allowed_numbers, "{k}: allowed numbers");
            let strs: Vec<&str> = rule["strings"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
            assert_eq!(strs, key.allowed_strings, "{k}: allowed strings");
        }
    }

    /// 0.90.34's `--audit-settings` (ledger CLI-002, SET-220): every stored key is edited by a row
    /// of the Settings window (src/windows/settings/registry.ts) or excused in its
    /// `UNINDEXED_KEYS` with a reason; every key a row names is stored; no row id repeats; a key
    /// several rows write is anchored by the row whose id is that key.
    #[test]
    fn every_stored_key_has_a_settings_row_or_a_reason() {
        let ts = include_str!("../../src/windows/settings/registry.ts");
        let quoted = |s: &str| -> Vec<String> { s.split('"').skip(1).step_by(2).map(str::to_string).collect() };
        let entries_at = ts.find("export const ENTRIES").expect("ENTRIES in registry.ts");
        let entries_end = entries_at + ts[entries_at..].find("\n];").expect("end of ENTRIES");
        let mut problems = vec![];
        let mut ids = std::collections::HashSet::new();
        let mut listers: std::collections::BTreeMap<String, Vec<String>> = Default::default();
        for line in ts[entries_at..entries_end].lines().map(str::trim).filter(|l| l.starts_with("{ id: \"")) {
            let id = quoted(line)[0].clone();
            if !ids.insert(id.clone()) {
                problems.push(format!("duplicate row id {id}"));
            }
            let keys = match line.find("keys: [") {
                Some(i) => quoted(&line[i..i + line[i..].find(']').unwrap()]),
                None => vec![id.clone()],
            };
            for k in keys {
                if find(&k).is_none() {
                    problems.push(format!("row {id} names {k}, which is not stored"));
                }
                listers.entry(k).or_default().push(id.clone());
            }
        }
        assert!(ids.len() > 80, "read only {} rows", ids.len());
        for (k, rows) in &listers {
            if rows.len() > 1 && !rows.contains(k) {
                problems.push(format!("{k} is written by {rows:?} but none of them has the id {k}"));
            }
        }
        let unindexed_at = ts.find("export const UNINDEXED_KEYS").expect("UNINDEXED_KEYS in registry.ts");
        let unindexed_end = unindexed_at + ts[unindexed_at..].find("\n};").unwrap();
        let unindexed: Vec<String> = ts[unindexed_at..unindexed_end]
            .lines()
            .map(str::trim)
            .filter(|l| l.starts_with('"'))
            .map(|l| quoted(l)[0].clone())
            .collect();
        for k in KEYS {
            if !listers.contains_key(k.name) && !unindexed.iter().any(|u| u == k.name) {
                problems.push(format!("{} is stored but no Settings row edits it and UNINDEXED_KEYS gives no reason", k.name));
            }
        }
        for u in &unindexed {
            if find(u).is_none() {
                problems.push(format!("UNINDEXED_KEYS names {u}, which is not stored"));
            }
        }
        assert!(problems.is_empty(), "{problems:#?}");
    }
}
