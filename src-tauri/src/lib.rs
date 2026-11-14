//! Qnet's app side: the windows, the menu bar, settings and state, and the commands the interface calls.
//!
//! This crate stays thin (PLAN.md §3). The interface owns the open documents; the model, the
//! exporters and the result parser go in `core/` (P1–P3) and the solver runner in `runner/` (P3),
//! so both are tested without a window. Every command is registered in the one handler list in
//! `run`, and every one has a handler in the browser preview's mock backend (src/dev/mock/), so the
//! preview keeps working.

mod ai;
mod analysis;
mod analysis_windows;
mod archetypes;
mod canvas_export;
mod canvas_native;
mod diagnostics;
mod documents;
mod edit;
mod errors;
mod files;
mod fit;
mod help;
mod identity;
mod inspector;
mod kv;
mod live;
mod animate;
mod menu;
mod quiet_runs;
mod sensitivity;
mod uncertainty;
mod optimise;
mod reports;
mod results_export;
mod runs;
mod session;
mod shell;
mod settings_io;
mod settings_schema;
mod status_log;
mod testsets;
mod transient;
mod updates;
mod util;
mod welcome;
mod windows;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

pub(crate) struct AppState {
    config_dir: PathBuf,
    data_dir: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    identifier: String,
    instance: &'static str,
    build_tag: &'static str,
    config_dir: String,
    data_dir: String,
}

#[tauri::command]
fn app_info(app: AppHandle, state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        identifier: app.config().identifier.clone(),
        instance: identity::instance_name(),
        build_tag: env!("QNET_BUILD_TAG"),
        config_dir: state.config_dir.display().to_string(),
        data_dir: state.data_dir.display().to_string(),
    }
}

/// Set once the interface has agreed to quit (its quit prompt and close guards are done).
static QUIT_AGREED: AtomicBool = AtomicBool::new(false);

/// Quits now. The interface calls this after Quit Qnet's prompts (ledger MENU-007, 5.10); a quit
/// from anywhere else (the Dock, logging out) is first sent to the interface as
/// `app://quit-requested`, so the same prompts run.
#[tauri::command]
fn app_exit(app: AppHandle) {
    QUIT_AGREED.store(true, Ordering::SeqCst);
    // An update's Install and Relaunch quits this same way, then starts the new version (updates.rs).
    if updates::take_relaunch() {
        app.request_restart();
        return;
    }
    app.exit(0);
}

/// Files macOS asked Qnet to open that the page hasn't taken yet.
#[derive(Default)]
pub(crate) struct OpenedFiles(std::sync::Mutex<Vec<String>>);

/// The `.bnet` files among `paths` (whatever the letter case of the extension), as strings.
fn bnet_paths(paths: impl Iterator<Item = PathBuf>) -> Vec<String> {
    paths
        .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("bnet")))
        // The path as the disk spells it (symlinks resolved, the stored letter case), so the page
        // recognises a file it already has open.
        .map(|p| std::fs::canonicalize(&p).unwrap_or(p))
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

/// The files macOS asked Qnet to open since the page last asked; each is handed over once.
#[tauri::command]
fn opened_files_take(pending: State<'_, OpenedFiles>) -> Vec<String> {
    std::mem::take(&mut *pending.0.lock().unwrap())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = identity::identifier().to_string();
    // Nothing, unless this build was made with an update endpoint and key (updates.rs).
    updates::configure(context.config_mut());
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(menu::MenuState::<tauri::Wry>::default())
        .manage(OpenedFiles::default())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_data_dir()?;
            app.manage(kv::Stores {
                settings: kv::KvStore::load(config_dir.join("settings.json")),
                state: kv::KvStore::load(data_dir.join("state.json")),
            });
            // The tab snapshot (src/workspace/tabs/session.ts), read once here (ledger WS-136).
            app.manage(session::Session::load(data_dir.join("session.json")));
            // The one single-flight registry, the solver resolver and the results store (P6).
            app.manage(runs::Runs::new(runs::store_path(&data_dir)));
            // The Shell pane's one login shell and its transcript file (P6, shell.rs).
            app.manage(shell::Shell::new(&data_dir));
            // The assistant: its requests in flight, and its keys in the Keychain (P7, ai.rs).
            app.manage(ai::Ai::with_keychain());
            // Automatic updates: registered only in a build configured for them (A5, updates.rs).
            updates::setup(app)?;
            app.manage(AppState { config_dir, data_dir });
            windows::create_main(app)?;
            Ok(())
        })
        .on_menu_event(|app, event| menu::on_menu_event(app, event.id().as_ref()))
        .invoke_handler(tauri::generate_handler![
            app_info,
            app_exit,
            opened_files_take,
            windows::aux_close,
            util::persistence_warnings,
            kv::settings_get,
            kv::settings_patch,
            kv::state_get,
            kv::state_patch,
            settings_schema::settings_schema_get,
            settings_io::settings_export,
            settings_io::settings_import,
            analysis::analysis_run,
            live::live_results,
            animate::animate_start,
            animate::animate_next,
            animate::animate_skip,
            animate::animate_stop,
            diagnostics::network_diagnostics,
            status_log::status_log_write,
            documents::document_read,
            documents::document_write,
            edit::native_edit,
            files::examples_locate,
            welcome::examples_list,
            files::export_text,
            files::export_save,
            files::export_all_inputs,
            files::network_generate,
            menu::menu_set,
            session::session_get,
            session::session_save,
            session::session_clear,
            session::window_document_state,
            runs::run_start,
            runs::run_stop,
            runs::run_active,
            runs::results_list,
            runs::results_get,
            runs::results_delete,
            runs::results_problem,
            reports::report_get,
            reports::reports_reveal,
            canvas_export::diagram_export,
            canvas_export::diagram_copy,
            canvas_export::diagram_print,
            canvas_export::diagram_page_setup,
            archetypes::network_archetype,
            inspector::inspector_stability,
            fit::fit_distribution,
            fit::fit_read_file,
            analysis_windows::report::analysis_report,
            analysis_windows::report::analysis_report_show,
            analysis_windows::advice::method_domain,
            analysis_windows::advice::method_availability,
            analysis_windows::deps::dependency_catalog,
            analysis_windows::deps::dependency_probe,
            results_export::results_fingerprint,
            results_export::results_export_text,
            results_export::results_export_save,
            shell::shell_start,
            shell::shell_input,
            shell::shell_resize,
            shell::shell_stop,
            shell::shell_transcript_load,
            shell::shell_transcript_save,
            shell::shell_transcript_clear,
            testsets::sweep_start,
            testsets::solver_lookup,
            quiet_runs::quiet_begin, quiet_runs::quiet_run, quiet_runs::quiet_end, quiet_runs::quiet_probe,
            sensitivity::sensitivity_analyze,
            uncertainty::uncertainty_analyze, uncertainty::uncertainty_linear,
            optimise::capacity_plan,
            transient::transient_prepare, transient::transient_analyze, transient::transient_stop,
            ai::ai_chat,
            ai::ai_cancel,
            ai::ai_key_set,
            ai::ai_key_status,
            ai::ai_key_delete,
            ai::ai_models,
            ai::ai_test,
            help::help_show,
            help::about_info,
            updates::update_status,
            updates::update_check,
            updates::update_install,
            updates::update_relaunch,
        ])
        .build(context)
        .expect("error while building Qnet");
    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, code: None, .. } => {
            if !QUIT_AGREED.load(Ordering::SeqCst) {
                api.prevent_exit();
                let _ = app.emit("app://quit-requested", ());
            }
        }
        // A solver still running when the app ends is stopped (Stop's ladder: SIGINT, SIGTERM at
        // 1.5 s, SIGKILL at 3 s, to its process group), waiting at most 4 s: solvers run in a group
        // of their own, so nothing else would end them.
        RunEvent::Exit => {
            if let Some(runs) = app.try_state::<runs::Runs>() {
                if runs.registry.stop().is_some() {
                    let until = std::time::Instant::now() + std::time::Duration::from_secs(4);
                    while runs.registry.active().is_some() && std::time::Instant::now() < until {
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                }
            }
        }
        // The red button and Close Window hide the main window rather than destroy it (its tabs
        // live in its page); a click on the Dock icon brings it back.
        // A .bnet opened from Finder or dropped on the Dock icon (new in 2.0, ledger WS-124). The
        // page may not be up yet at launch, so the paths wait until it asks (`opened_files_take`).
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => {
            let paths = bnet_paths(urls.iter().filter_map(|u| u.to_file_path().ok()));
            if !paths.is_empty() {
                if let Some(pending) = app.try_state::<OpenedFiles>() {
                    pending.0.lock().unwrap().extend(paths);
                }
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                let _ = app.emit("app://open-files", ());
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { has_visible_windows: false, .. } => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_bnet_files_are_taken_from_what_finder_sends() {
        let got = super::bnet_paths(["/a/tandem.bnet", "/a/Notes.txt", "/b/UPPER.BNET", "/c/noext"].iter().map(std::path::PathBuf::from));
        assert_eq!(got, vec!["/a/tandem.bnet".to_string(), "/b/UPPER.BNET".to_string()]);
    }

    /// Every command in the handler list has a handler in the browser preview's mock backend
    /// (one of the files in src/dev/mock/), so mock.html never meets a command it can't answer.
    #[test]
    fn every_command_has_a_mock_in_the_browser_preview() {
        let lib = include_str!("lib.rs");
        let start = lib.find("generate_handler![").expect("the handler list") + "generate_handler![".len();
        let list = &lib[start..start + lib[start..].find(']').unwrap()];
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/dev/mock");
        let mut mock = String::new();
        for e in std::fs::read_dir(&dir).expect("src/dev/mock") {
            let p = e.unwrap().path();
            if p.extension().is_some_and(|x| x == "ts") {
                mock.push_str(&std::fs::read_to_string(p).unwrap());
            }
        }
        let commands: Vec<&str> = list.split(',').map(|c| c.trim().rsplit("::").next().unwrap().trim()).filter(|c| !c.is_empty()).collect();
        assert!(commands.len() >= 10, "{commands:?}");
        for c in commands {
            assert!(mock.contains(&format!("{c}:")), "no file in src/dev/mock/ has a handler for {c}");
        }
    }
}
