mod menu;
mod pdf;
mod reminders;
mod vault;
mod watcher;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Emitter, Manager, RunEvent, WindowEvent};

const MAIN_WINDOW: &str = "main";

#[derive(Default)]
struct ExitState {
    allowed: AtomicBool,
}

/// Called only after the frontend has persisted its pending edits and archives.
#[tauri::command]
fn allow_exit(app: tauri::AppHandle, state: tauri::State<'_, ExitState>) {
    state.allowed.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(vault::AppState::default())
        .manage(ExitState::default())
        .menu(menu::build)
        .on_menu_event(menu::handle_event)
        .on_window_event(|window, event| {
            // Closing the main window hides it; the Dock icon brings it back.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN_WINDOW {
                    api.prevent_close();
                    if let Err(e) = window.hide() {
                        eprintln!("tasks: cannot hide window: {e}");
                    }
                }
            }
        })
        .setup(|app| {
            vault::restore_vault(app.handle());
            reminders::init();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault::get_vault,
            vault::set_vault,
            vault::list_vault,
            vault::read_file,
            vault::write_file,
            vault::create_file,
            vault::create_dir,
            vault::rename_path,
            vault::trash_path,
            vault::save_attachment,
            vault::save_attachment_bytes,
            reminders::schedule_reminders,
            pdf::export_pdf,
            allow_exit,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        match event {
            RunEvent::ExitRequested { api, .. } => {
                if !app.state::<ExitState>().allowed.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                        let _ = window.show();
                        let _ = window.set_focus();
                        if let Err(error) = window.emit("exit-requested", ()) {
                            eprintln!("tasks: cannot request pending-save flush: {error}");
                        }
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
        }
    });
}
