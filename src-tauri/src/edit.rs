//! Edit ▸ Undo, Redo, Cut, Copy, Paste and Select All while a text field in the page has focus.
//!
//! The Edit menu's items are Qnet's own commands (the canvas has its undo stack, its selection and
//! its clipboard), so AppKit no longer delivers ⌘Z or ⌘C to the web view by itself. When the page
//! says a text field owns the keystroke, the action is sent down AppKit's responder chain instead,
//! exactly as 0.90.34's Edit menu did with `NSApp.sendAction(_:to:from:)`: the web view's field
//! editor then undoes its own typing and uses the real pasteboard.

use crate::errors::QnError;

/// The selectors the page may ask for, by its own names.
fn selector(action: &str) -> Option<&'static std::ffi::CStr> {
    Some(match action {
        "undo" => c"undo:",
        "redo" => c"redo:",
        "cut" => c"cut:",
        "copy" => c"copy:",
        "paste" => c"paste:",
        "selectAll" => c"selectAll:",
        "delete" => c"delete:",
        _ => return None,
    })
}

#[tauri::command]
pub fn native_edit(app: tauri::AppHandle, action: String) -> Result<(), QnError> {
    let Some(sel) = selector(&action) else {
        return Err(QnError::invalid(format!("“{action}” isn't an edit action Qnet knows.")));
    };
    #[cfg(target_os = "macos")]
    {
        let _ = app.run_on_main_thread(move || send(sel));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, sel);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn send(sel: &'static std::ffi::CStr) {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Bool, Sel};
    let Some(cls) = AnyClass::get(c"NSApplication") else { return };
    let sel = Sel::register(sel);
    unsafe {
        let app: *mut AnyObject = msg_send![cls, sharedApplication];
        let none: *mut AnyObject = std::ptr::null_mut();
        let _: Bool = msg_send![app, sendAction: sel, to: none, from: none];
    }
}

#[cfg(test)]
mod tests {
    use super::selector;

    #[test]
    fn every_action_the_page_sends_has_a_selector() {
        for a in ["undo", "redo", "cut", "copy", "paste", "selectAll", "delete"] {
            assert!(selector(a).is_some(), "{a}");
        }
        assert!(selector("print").is_none());
    }
}
