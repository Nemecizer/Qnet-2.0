//! The native menu bar, built from the description the interface sends (src/lib/menu.ts).
//!
//! The interface owns the one command list (src/lib/commands.ts) and the menu's layout
//! (src/lib/menuSpec.ts), so labels, shortcuts, check marks and enablement have one source; this
//! module only turns that description into AppKit menus. `menu_set` is called whenever the
//! description changes: when only labels, check marks, enablement or shortcuts changed, the
//! existing items are updated in place (an open menu doesn't flicker); when items were added or
//! removed (Open Recent, the Window menu's tab list), the bar is rebuilt.
//!
//! Every custom item reports a click as the event `menu://click` with the item's id.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime, State};

use crate::errors::QnError;

/// One entry of the description (src/lib/menu.ts `MenuNode`).
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MenuNode {
    /// A command. `checked` present makes it a check-mark item.
    #[serde(rename_all = "camelCase")]
    Item { id: String, label: String, accel: Option<String>, enabled: bool, checked: Option<bool> },
    /// A submenu; `role` "window" or "help" hands it to AppKit as the Window or Help menu.
    #[serde(rename_all = "camelCase")]
    Submenu { label: String, items: Vec<MenuNode>, #[serde(default = "yes")] enabled: bool, role: Option<String> },
    Separator,
    /// A section title inside a menu (the Run menu's "Infinite-Buffer Methods"): a dimmed item.
    Header { label: String },
    /// An item AppKit provides (About aside, which is Qnet's own): see `predefined`.
    Predefined { role: String },
}

fn yes() -> bool {
    true
}

/// The shape of a description: what must match for an in-place update.
fn shape(nodes: &[MenuNode], out: &mut String) {
    for n in nodes {
        match n {
            MenuNode::Item { id, checked, accel, .. } => {
                out.push_str(if checked.is_some() { "c:" } else { "i:" });
                out.push_str(id);
                // An item's shortcut is part of the shape: muda's macOS `set_accelerator(None)`
                // leaves the old key equivalent in place, so a shortcut that moves (the buffer-mode
                // pairs, MENU-114) must rebuild the menu rather than update it in place.
                if let Some(a) = accel {
                    out.push('[');
                    out.push_str(a);
                    out.push(']');
                }
            }
            MenuNode::Submenu { items, role, .. } => {
                out.push_str("s(");
                out.push_str(role.as_deref().unwrap_or(""));
                out.push(':');
                shape(items, out);
                out.push(')');
            }
            MenuNode::Separator => out.push('-'),
            MenuNode::Header { label } => {
                out.push_str("h:");
                out.push_str(label);
            }
            MenuNode::Predefined { role } => {
                out.push_str("p:");
                out.push_str(role);
            }
        }
        out.push(';');
    }
}

pub fn shape_of(nodes: &[MenuNode]) -> String {
    let mut s = String::new();
    shape(nodes, &mut s);
    s
}

/// Ids that appear twice, which AppKit's menus would confuse.
pub fn duplicate_ids(nodes: &[MenuNode]) -> Vec<String> {
    fn walk(nodes: &[MenuNode], seen: &mut HashMap<String, usize>) {
        for n in nodes {
            match n {
                MenuNode::Item { id, .. } => *seen.entry(id.clone()).or_default() += 1,
                MenuNode::Submenu { items, .. } => walk(items, seen),
                _ => {}
            }
        }
    }
    let mut seen = HashMap::new();
    walk(nodes, &mut seen);
    let mut d: Vec<String> = seen.into_iter().filter(|(_, n)| *n > 1).map(|(k, _)| k).collect();
    d.sort();
    d
}

/// Shortcuts that two enabled-or-not items share (0.90.34's `MenuShortcutAudit`, ledger MENU-199).
#[cfg(any(test, debug_assertions))]
pub fn duplicate_accels(nodes: &[MenuNode]) -> Vec<String> {
    fn walk(nodes: &[MenuNode], seen: &mut HashMap<String, Vec<String>>) {
        for n in nodes {
            match n {
                MenuNode::Item { id, accel: Some(a), .. } => seen.entry(a.to_lowercase()).or_default().push(id.clone()),
                MenuNode::Submenu { items, .. } => walk(items, seen),
                _ => {}
            }
        }
    }
    let mut seen = HashMap::new();
    walk(nodes, &mut seen);
    let mut d: Vec<String> = seen.into_iter().filter(|(_, ids)| ids.len() > 1).map(|(a, ids)| format!("{a}: {}", ids.join(", "))).collect();
    d.sort();
    d
}

enum Handle<R: Runtime> {
    Item(MenuItem<R>),
    Check(CheckMenuItem<R>),
}

pub struct MenuState<R: Runtime> {
    inner: Mutex<Option<Built<R>>>,
}

impl<R: Runtime> Default for MenuState<R> {
    fn default() -> Self {
        MenuState { inner: Mutex::new(None) }
    }
}

struct Built<R: Runtime> {
    shape: String,
    nodes: Vec<MenuNode>,
    items: HashMap<String, Handle<R>>,
    submenus: Vec<Submenu<R>>,
}

fn predefined<R: Runtime>(app: &AppHandle<R>, role: &str) -> tauri::Result<PredefinedMenuItem<R>> {
    match role {
        "services" => PredefinedMenuItem::services(app, None),
        "hide" => PredefinedMenuItem::hide(app, Some("Hide Qnet")),
        "hideOthers" => PredefinedMenuItem::hide_others(app, None),
        "showAll" => PredefinedMenuItem::show_all(app, None),
        "quit" => PredefinedMenuItem::quit(app, Some("Quit Qnet")),
        "undo" => PredefinedMenuItem::undo(app, None),
        "redo" => PredefinedMenuItem::redo(app, None),
        "cut" => PredefinedMenuItem::cut(app, None),
        "copy" => PredefinedMenuItem::copy(app, None),
        "paste" => PredefinedMenuItem::paste(app, None),
        "selectAll" => PredefinedMenuItem::select_all(app, None),
        "minimize" => PredefinedMenuItem::minimize(app, None),
        "zoom" => PredefinedMenuItem::maximize(app, Some("Zoom")),
        "fullscreen" => PredefinedMenuItem::fullscreen(app, None),
        "bringAllToFront" => PredefinedMenuItem::bring_all_to_front(app, None),
        "closeWindow" => PredefinedMenuItem::close_window(app, None),
        // menu_set refuses unknown roles before building (`unknown_roles`).
        _ => PredefinedMenuItem::separator(app),
    }
}

/// The AppKit items a description may name.
pub const ROLES: &[&str] = &[
    "services", "hide", "hideOthers", "showAll", "quit", "undo", "redo", "cut", "copy", "paste", "selectAll",
    "minimize", "zoom", "fullscreen", "bringAllToFront", "closeWindow",
];

pub fn unknown_roles(nodes: &[MenuNode]) -> Vec<String> {
    let mut v = Vec::new();
    for n in nodes {
        match n {
            MenuNode::Predefined { role } if !ROLES.contains(&role.as_str()) => v.push(role.clone()),
            MenuNode::Submenu { items, .. } => v.extend(unknown_roles(items)),
            _ => {}
        }
    }
    v
}

fn build_items<R: Runtime>(app: &AppHandle<R>, nodes: &[MenuNode], built: &mut Built<R>, header_seq: &mut usize) -> tauri::Result<Vec<Box<dyn IsMenuItem<R>>>> {
    let mut out: Vec<Box<dyn IsMenuItem<R>>> = Vec::new();
    for n in nodes {
        match n {
            MenuNode::Item { id, label, accel, enabled, checked } => match checked {
                Some(c) => {
                    let item = CheckMenuItem::with_id(app, id.as_str(), label, *enabled, *c, accel.as_deref())?;
                    out.push(Box::new(item.clone()));
                    built.items.insert(id.clone(), Handle::Check(item));
                }
                None => {
                    let item = MenuItem::with_id(app, id.as_str(), label, *enabled, accel.as_deref())?;
                    out.push(Box::new(item.clone()));
                    built.items.insert(id.clone(), Handle::Item(item));
                }
            },
            MenuNode::Submenu { label, items, enabled, role } => {
                let children = build_items(app, items, built, header_seq)?;
                let refs: Vec<&dyn IsMenuItem<R>> = children.iter().map(|b| b.as_ref()).collect();
                let sub = Submenu::with_items(app, label, *enabled, &refs)?;
                #[cfg(target_os = "macos")]
                match role.as_deref() {
                    Some("window") => sub.set_as_windows_menu_for_nsapp()?,
                    Some("help") => sub.set_as_help_menu_for_nsapp()?,
                    _ => {}
                }
                #[cfg(not(target_os = "macos"))]
                let _ = role;
                built.submenus.push(sub.clone());
                out.push(Box::new(sub));
            }
            MenuNode::Separator => out.push(Box::new(PredefinedMenuItem::separator(app)?)),
            MenuNode::Header { label } => {
                *header_seq += 1;
                out.push(Box::new(MenuItem::with_id(app, format!("header:{header_seq}"), label, false, None::<&str>)?));
            }
            MenuNode::Predefined { role } => out.push(Box::new(predefined(app, role)?)),
        }
    }
    Ok(out)
}

fn build<R: Runtime>(app: &AppHandle<R>, nodes: Vec<MenuNode>) -> tauri::Result<Built<R>> {
    let mut built = Built { shape: shape_of(&nodes), nodes: Vec::new(), items: HashMap::new(), submenus: Vec::new() };
    let mut seq = 0;
    let top = build_items(app, &nodes, &mut built, &mut seq)?;
    let refs: Vec<&dyn IsMenuItem<R>> = top.iter().map(|b| b.as_ref()).collect();
    let menu = Menu::with_items(app, &refs)?;
    app.set_menu(menu)?;
    built.nodes = nodes;
    Ok(built)
}

/// Updates labels, shortcuts, check marks and enablement in place.
fn update<R: Runtime>(built: &mut Built<R>, nodes: Vec<MenuNode>) -> tauri::Result<()> {
    fn walk<R: Runtime>(old: &[MenuNode], new: &[MenuNode], items: &HashMap<String, Handle<R>>, subs: &mut std::slice::Iter<'_, Submenu<R>>, pending: &mut Vec<(Submenu<R>, String, bool, String, bool)>) -> tauri::Result<()> {
        for (o, n) in old.iter().zip(new) {
            match (o, n) {
                (
                    MenuNode::Item { label: ol, accel: oa, enabled: oe, checked: oc, .. },
                    MenuNode::Item { id, label, accel, enabled, checked },
                ) => {
                    let h = &items[id];
                    match h {
                        Handle::Item(i) => {
                            if ol != label { i.set_text(label)?; }
                            if oe != enabled { i.set_enabled(*enabled)?; }
                            if oa != accel { i.set_accelerator(accel.as_deref())?; }
                        }
                        Handle::Check(i) => {
                            if ol != label { i.set_text(label)?; }
                            if oe != enabled { i.set_enabled(*enabled)?; }
                            if oa != accel { i.set_accelerator(accel.as_deref())?; }
                            if oc != checked { i.set_checked(checked.unwrap_or(false))?; }
                        }
                    }
                }
                (MenuNode::Submenu { items: oi, label: ol, enabled: oe, .. }, MenuNode::Submenu { items: ni, label, enabled, .. }) => {
                    // Submenus were pushed after their children, so walk the children first.
                    walk(oi, ni, items, subs, pending)?;
                    let sub = subs.next().expect("one handle per submenu").clone();
                    pending.push((sub, ol.clone(), *oe, label.clone(), *enabled));
                }
                _ => {}
            }
        }
        Ok(())
    }
    let mut pending = Vec::new();
    let subs = built.submenus.clone();
    walk(&built.nodes, &nodes, &built.items, &mut subs.iter(), &mut pending)?;
    for (sub, ol, oe, label, enabled) in pending {
        if ol != label { sub.set_text(&label)?; }
        if oe != enabled { sub.set_enabled(enabled)?; }
    }
    built.nodes = nodes;
    Ok(())
}

/// Installs or updates the menu bar from the interface's description.
#[tauri::command]
pub fn menu_set(app: AppHandle, state: State<'_, MenuState<tauri::Wry>>, menu: Vec<MenuNode>) -> Result<(), QnError> {
    let dupes = duplicate_ids(&menu);
    if !dupes.is_empty() {
        return Err(QnError::invalid(format!("Two menu items share an id: {}.", dupes.join(", "))));
    }
    let roles = unknown_roles(&menu);
    if !roles.is_empty() {
        return Err(QnError::invalid(format!("The menu names AppKit items Qnet doesn't know: {}.", roles.join(", "))));
    }
    // 0.90.34's MenuShortcutAudit (ledger MENU-199): debug builds name any shortcut two items share.
    #[cfg(debug_assertions)]
    for d in duplicate_accels(&menu) {
        eprintln!("menu: two items share a shortcut: {d}");
    }
    let mut guard = state.inner.lock().unwrap();
    let same_shape = guard.as_ref().is_some_and(|b| b.shape == shape_of(&menu));
    let result = if same_shape {
        update(guard.as_mut().unwrap(), menu)
    } else {
        build(&app, menu).map(|b| *guard = Some(b))
    };
    result.map_err(|e| QnError::failed("Qnet couldn't update the menu bar.").with_detail(e.to_string()))
}

/// Forwards clicks on custom items to the interface.
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if id.starts_with("header:") {
        return;
    }
    let _ = app.emit("menu://click", id.to_string());
}

/// Ids in the menu as the given kind (for tests).
#[cfg(test)]
fn ids(nodes: &[MenuNode]) -> Vec<String> {
    let mut v = Vec::new();
    for n in nodes {
        match n {
            MenuNode::Item { id, .. } => v.push(id.clone()),
            MenuNode::Submenu { items, .. } => v.extend(ids(items)),
            _ => {}
        }
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> Vec<MenuNode> {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn the_description_reads_and_its_shape_ignores_labels_and_state_but_not_shortcuts() {
        let a = parse(r#"[{"type":"submenu","label":"File","items":[
            {"type":"item","id":"file:new","label":"New Network","accel":"CmdOrCtrl+N","enabled":true},
            {"type":"separator"},
            {"type":"item","id":"view:pane-tools","label":"Tools","enabled":true,"checked":true},
            {"type":"header","label":"Infinite-Buffer Methods"},
            {"type":"predefined","role":"quit"}]}]"#);
        let b = parse(r#"[{"type":"submenu","label":"File","items":[
            {"type":"item","id":"file:new","label":"New","accel":"CmdOrCtrl+N","enabled":false},
            {"type":"separator"},
            {"type":"item","id":"view:pane-tools","label":"Tools","enabled":true,"checked":false},
            {"type":"header","label":"Infinite-Buffer Methods"},
            {"type":"predefined","role":"quit"}]}]"#);
        assert_eq!(shape_of(&a), shape_of(&b));
        assert_eq!(ids(&a), ["file:new", "view:pane-tools"]);
        let c = parse(r#"[{"type":"submenu","label":"File","items":[{"type":"item","id":"file:recent:0","label":"a.bnet","enabled":true}]}]"#);
        assert_ne!(shape_of(&a), shape_of(&c));
        // A shortcut that moves or goes is a new shape: muda can't clear a key equivalent in place.
        let no_key = parse(r#"[{"type":"submenu","label":"File","items":[
            {"type":"item","id":"file:new","label":"New","enabled":false},
            {"type":"separator"},
            {"type":"item","id":"view:pane-tools","label":"Tools","enabled":true,"checked":false},
            {"type":"header","label":"Infinite-Buffer Methods"},
            {"type":"predefined","role":"quit"}]}]"#);
        assert_ne!(shape_of(&b), shape_of(&no_key));
    }

    #[test]
    fn duplicate_ids_and_shortcuts_are_found() {
        let m = parse(r#"[{"type":"submenu","label":"A","items":[
            {"type":"item","id":"x","label":"X","accel":"CmdOrCtrl+K","enabled":true},
            {"type":"submenu","label":"B","items":[
                {"type":"item","id":"x","label":"X2","enabled":true},
                {"type":"item","id":"y","label":"Y","accel":"cmdorctrl+k","enabled":true}]}]}]"#);
        assert_eq!(duplicate_ids(&m), ["x"]);
        assert_eq!(duplicate_accels(&m), ["cmdorctrl+k: x, y"]);
        assert_eq!(unknown_roles(&parse(r#"[{"type":"predefined","role":"quit"},{"type":"predefined","role":"print"}]"#)), ["print"]);
    }
}
