mod export;
mod menu;
mod pdf;
#[cfg(target_os = "macos")]
mod quit;
mod reminders;
mod tracker;
mod vault;
mod vaultfile;
mod watcher;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{DragDropEvent, Emitter, Manager, RunEvent, WindowEvent};

const MAIN_WINDOW: &str = "main";

#[derive(Default)]
struct ExitState {
    allowed: AtomicBool,
}

/// True once the frontend has confirmed that nothing is left to save.
pub(crate) fn exit_allowed(app: &tauri::AppHandle) -> bool {
    app.state::<ExitState>().allowed.load(Ordering::SeqCst)
}

/// Called only after the frontend has persisted its pending edits and archives.
#[tauri::command]
fn allow_exit(app: tauri::AppHandle, state: tauri::State<'_, ExitState>) {
    state.allowed.store(true, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    if quit::answer_pending(&app, true) {
        return;
    }
    app.exit(0);
}

/// Called when the frontend could not save everything: a quit that AppKit is waiting
/// on (Dock, logout, AppleScript) is cancelled instead of left hanging.
#[tauri::command]
fn cancel_exit(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    quit::answer_pending(&app, false);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(vault::AppState::default())
        .manage(export::ExportState::default())
        .manage(ExitState::default())
        .register_asynchronous_uri_scheme_protocol(vaultfile::SCHEME, vaultfile::handle)
        .menu(menu::build)
        .on_menu_event(menu::handle_event)
        .on_window_event(|window, event| match event {
            // Closing the main window hides it; the Dock icon brings it back.
            WindowEvent::CloseRequested { api, .. } if window.label() == MAIN_WINDOW => {
                api.prevent_close();
                if let Err(e) = window.hide() {
                    eprintln!("tasks: cannot hide window: {e}");
                }
            }
            // Only files the user dropped may be imported as attachments.
            WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
                window.state::<vault::AppState>().remember_dropped(paths);
            }
            _ => {}
        })
        .setup(|app| {
            vault::restore_vault(app.handle());
            reminders::init();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault::get_vault,
            vault::choose_vault,
            vault::list_vault,
            vault::read_vault_files,
            vault::read_file,
            vault::write_file,
            vault::create_file,
            vault::create_dir,
            vault::rename_path,
            vault::trash_path,
            vault::open_vault_path,
            vault::save_attachment,
            vault::save_attachment_bytes,
            export::choose_export_path,
            export::write_export,
            pdf::export_pdf,
            reminders::schedule_reminders,
            allow_exit,
            cancel_exit,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    #[cfg(target_os = "macos")]
    quit::install(app.handle());

    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, .. } if !exit_allowed(app) => {
            // Without the window nothing can be pending, so let the exit proceed.
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                api.prevent_exit();
                let _ = window.show();
                let _ = window.set_focus();
                if let Err(error) = window.emit("exit-requested", ()) {
                    eprintln!("tasks: cannot request pending-save flush: {error}");
                }
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        _ => {}
    });
}
