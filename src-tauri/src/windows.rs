//! The main window, and the auxiliary windows the interface opens from it.
//!
//! Auxiliary windows (Settings, detached panes, panels) are opened by the main window's page with
//! `window.open("about:blank#aux=<name>&minw=<w>&minh=<h>", …)` (src/lib/auxWindow.tsx). macOS
//! creates them with the opener's WebKit configuration, so the page that opened one can render
//! into it directly: a detached Status pane or the Settings window is the main window's own React
//! tree, sharing its documents and stores, with nothing to synchronise between windows. Rust only
//! names the window (`aux-<name>`), applies its minimum size, keeps its title in step with the
//! page's `document.title`, and turns window tabbing off (ledger WS-005, MENU-141).

use std::sync::atomic::{AtomicUsize, Ordering};

use tauri::webview::NewWindowResponse;
use tauri::{App, AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// What the fragment of an auxiliary window's address asks for.
#[derive(Debug, PartialEq)]
pub struct AuxRequest {
    pub name: String,
    /// Chosen by the page, so it knows the window's label (`aux-<name>-<id>`) and can close it.
    pub id: Option<String>,
    pub min_size: Option<(f64, f64)>,
}

/// Reads `about:blank#aux=settings&minw=640&minh=480`. Names are `[a-z0-9-]`, up to 40.
/// Anything else (another page, a web address) is refused, so a link can't open a window.
pub fn parse_aux(url: &str) -> Option<AuxRequest> {
    let frag = url.strip_prefix("about:blank#")?;
    let mut name = None;
    let mut id = None;
    let (mut w, mut h) = (None, None);
    for pair in frag.split('&') {
        let (k, v) = pair.split_once('=')?;
        match k {
            "aux" => name = Some(v.to_string()),
            "id" => id = Some(v.to_string()),
            "minw" => w = v.parse::<f64>().ok(),
            "minh" => h = v.parse::<f64>().ok(),
            _ => {}
        }
    }
    let name = name?;
    if name.is_empty() || name.len() > 40 || !name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
        return None;
    }
    if id.as_ref().is_some_and(|i| i.is_empty() || i.len() > 24 || !i.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())) {
        return None;
    }
    Some(AuxRequest { name, id, min_size: w.zip(h) })
}

static SEQ: AtomicUsize = AtomicUsize::new(0);

fn aux_label(app: &AppHandle, name: &str) -> String {
    let base = format!("aux-{name}");
    if app.get_webview_window(&base).is_none() {
        return base;
    }
    format!("{base}-{}", SEQ.fetch_add(1, Ordering::Relaxed) + 1)
}

/// Closes the native window labelled `label` (an auxiliary window's; the page knows the label,
/// `aux-<name>-<id>`, because it chose the id). The page's own `window.close()` empties the web
/// view but leaves the window on screen, so the page asks for this as well.
#[tauri::command]
pub fn aux_close(app: AppHandle, label: String) {
    if !label.starts_with("aux-") {
        return;
    }
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.destroy();
    }
}

/// Builds the main window from tauri.conf.json (which has `create: false`), with the handler
/// that turns the page's `window.open` calls into auxiliary windows.
pub fn create_main(app: &App) -> tauri::Result<()> {
    let config = app.config().app.windows.iter().find(|w| w.label == "main").cloned().expect("tauri.conf.json defines the main window");
    let handle = app.handle().clone();
    WebviewWindowBuilder::from_config(app.handle(), &config)?
        .on_new_window(move |url, features| {
            let Some(req) = parse_aux(url.as_str()) else { return NewWindowResponse::Deny };
            let label = match &req.id {
                Some(id) if handle.get_webview_window(&format!("aux-{}-{id}", req.name)).is_none() => format!("aux-{}-{id}", req.name),
                _ => aux_label(&handle, &req.name),
            };
            let mut b = WebviewWindowBuilder::new(&handle, &label, WebviewUrl::External("about:blank".parse().unwrap()))
                .window_features(features)
                .title("Qnet")
                .on_document_title_changed(|w, title| {
                    #[cfg(debug_assertions)]
                    selftest::on_title(&w.app_handle(), &title);
                    let _ = w.set_title(&title);
                });
            if let Some((w, h)) = req.min_size {
                b = b.min_inner_size(w, h);
            }
            match b.build() {
                Ok(window) => NewWindowResponse::Create { window },
                Err(_) => NewWindowResponse::Deny,
            }
        })
        .build()?;
    #[cfg(target_os = "macos")]
    disable_window_tabbing();
    #[cfg(debug_assertions)]
    selftest::start(app.handle());
    Ok(())
}

/// `QNET_SELFTEST=aux npm run tauri dev`: after launch the page opens an auxiliary window, renders
/// into it from the main window's React, installs the menu bar, and reports through that window's
/// title; this prints the report and quits (exit status 0 when every check passed). Debug builds only.
#[cfg(debug_assertions)]
mod selftest {
    use tauri::{AppHandle, Manager};

    fn on() -> bool {
        std::env::var("QNET_SELFTEST").is_ok_and(|v| v == "aux")
    }

    pub fn start(app: &AppHandle) {
        if !on() {
            return;
        }
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(6));
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.eval("window.__qnetSelfTest ? window.__qnetSelfTest() : document.title = 'no self-test hook'");
            }
            std::thread::sleep(std::time::Duration::from_secs(480));
            println!("QNET SELFTEST: no report within 480 s");
            app.exit(2);
        });
    }

    pub fn on_title(app: &AppHandle, title: &str) {
        if on() && title.starts_with("SELFTEST") {
            println!("QNET {title}");
            let ok = title.starts_with("SELFTEST OK");
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || {
                #[cfg(target_os = "macos")]
                print_main_menu();
                #[cfg(target_os = "macos")]
                print_pasteboard_types();
                app2.exit(if ok { 0 } else { 1 });
            });
        }
    }

    /// What Copy as Image left on the general pasteboard (0.90.34 wrote PDF and TIFF).
    #[cfg(target_os = "macos")]
    fn print_pasteboard_types() {
        use objc2::msg_send;
        use objc2::runtime::{AnyClass, AnyObject};
        let Some(cls) = AnyClass::get(c"NSPasteboard") else { return };
        unsafe {
            let pb: *mut AnyObject = msg_send![cls, generalPasteboard];
            let types: *mut AnyObject = msg_send![pb, types];
            let n: usize = if types.is_null() { 0 } else { msg_send![types, count] };
            let mut names = Vec::new();
            for i in 0..n {
                let s: *mut AnyObject = msg_send![types, objectAtIndex: i];
                let p: *const std::ffi::c_char = msg_send![s, UTF8String];
                if !p.is_null() {
                    names.push(std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned());
                }
            }
            println!("QNET PASTEBOARD {}", names.join(", "));
        }
    }

    /// The menu bar as AppKit holds it (AppKit adds items of its own, such as Start Dictation):
    /// one line per item, indented by depth, with its key equivalent and modifiers.
    #[cfg(target_os = "macos")]
    fn print_main_menu() {
        use objc2::msg_send;
        use objc2::runtime::{AnyClass, AnyObject, Bool};
        unsafe fn text(s: *mut AnyObject) -> String {
            if s.is_null() {
                return String::new();
            }
            let p: *const std::ffi::c_char = msg_send![s, UTF8String];
            if p.is_null() { String::new() } else { std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned() }
        }
        unsafe fn walk(menu: *mut AnyObject, depth: usize, keys: &mut Vec<String>) {
            let n: isize = msg_send![menu, numberOfItems];
            for i in 0..n {
                let item: *mut AnyObject = msg_send![menu, itemAtIndex: i];
                let sep: Bool = msg_send![item, isSeparatorItem];
                let hidden: Bool = msg_send![item, isHidden];
                let alternate: Bool = msg_send![item, isAlternate];
                let title = text(msg_send![item, title]);
                let key = text(msg_send![item, keyEquivalent]);
                let mask: usize = msg_send![item, keyEquivalentModifierMask];
                let enabled: Bool = msg_send![item, isEnabled];
                let mods = [(1usize << 18, "⌃"), (1 << 19, "⌥"), (1 << 17, "⇧"), (1 << 20, "⌘")]
                    .iter()
                    .filter(|(m, _)| mask & m != 0)
                    .map(|(_, g)| *g)
                    .collect::<String>();
                let shortcut = if key.is_empty() { String::new() } else { format!("  [{mods}{}]", key.to_uppercase()) };
                if sep.as_bool() {
                    println!("QNET MENU {}----", "  ".repeat(depth));
                } else {
                    println!("QNET MENU {}{title}{shortcut}{}{}", "  ".repeat(depth), if enabled.as_bool() { "" } else { "  (dimmed)" }, if hidden.as_bool() { "  (hidden)" } else { "" });
                    if !key.is_empty() && !hidden.as_bool() && !alternate.as_bool() {
                        keys.push(format!("{mods}{}", key.to_uppercase()));
                    }
                }
                let sub: *mut AnyObject = msg_send![item, submenu];
                if !sub.is_null() {
                    walk(sub, depth + 1, keys);
                }
            }
        }
        unsafe {
            let Some(cls) = AnyClass::get(c"NSApplication") else { return };
            let app: *mut AnyObject = msg_send![cls, sharedApplication];
            let menu: *mut AnyObject = msg_send![app, mainMenu];
            if menu.is_null() {
                println!("QNET MENU (none)");
                return;
            }
            let mut keys = Vec::new();
            walk(menu, 0, &mut keys);
            keys.sort();
            let mut dupes: Vec<&String> = keys.windows(2).filter(|w| w[0] == w[1]).map(|w| &w[0]).collect();
            dupes.dedup();
            println!("QNET MENU shortcuts: {} total, shared: {:?}", keys.len(), dupes);
        }
    }
}

/// `NSWindow.allowsAutomaticWindowTabbing = false`: no Show Tab Bar items, ⌘T merges nothing.
#[cfg(target_os = "macos")]
fn disable_window_tabbing() {
    use objc2::runtime::{AnyClass, Bool};
    use objc2::msg_send;
    if let Some(cls) = AnyClass::get(c"NSWindow") {
        let _: () = unsafe { msg_send![cls, setAllowsAutomaticWindowTabbing: Bool::NO] };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_aux_address_may_carry_the_id_its_label_ends_with() {
        let r = parse_aux("about:blank#aux=about&id=m3x9k2a1").unwrap();
        assert_eq!((r.name.as_str(), r.id.as_deref()), ("about", Some("m3x9k2a1")));
        assert_eq!(parse_aux("about:blank#aux=about&id=../x"), None);
        assert_eq!(parse_aux("about:blank#aux=about&id="), None);
    }

    #[test]
    fn an_aux_address_names_the_window_and_its_minimum_size() {
        assert_eq!(parse_aux("about:blank#aux=settings&minw=640&minh=480"), Some(AuxRequest { name: "settings".into(), id: None, min_size: Some((640.0, 480.0)) }));
        assert_eq!(parse_aux("about:blank#aux=pane-status"), Some(AuxRequest { name: "pane-status".into(), id: None, min_size: None }));
        assert_eq!(parse_aux("about:blank"), None);
        assert_eq!(parse_aux("https://example.com/#aux=x"), None);
        assert_eq!(parse_aux("about:blank#aux=../etc"), None);
        assert_eq!(parse_aux("about:blank#aux="), None);
    }
}
