//! Export destinations: only paths the user chose in a save dialog may be written.

use std::collections::HashSet;
use std::path::PathBuf;

use parking_lot::Mutex;
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::vault::{atomic_write, blocking, canonicalize_lenient, err_str, path_string};

const EXPORT_EXTENSIONS: &[&str] = &["pdf", "html", "md"];

/// Paths chosen through `choose_export_path` that have not been written yet.
#[derive(Default)]
pub struct ExportState {
    chosen: Mutex<HashSet<PathBuf>>,
}

impl ExportState {
    fn allow(&self, path: PathBuf) {
        self.chosen.lock().insert(path);
    }

    /// Consumes the permission to write `path`.
    pub fn take(&self, path: &str) -> Result<PathBuf, String> {
        let key = canonicalize_lenient(std::path::Path::new(path))?;
        if self.chosen.lock().remove(&key) {
            Ok(key)
        } else {
            Err(format!("{path} was not chosen as an export destination"))
        }
    }
}

/// Shows the save dialog for an export; None when cancelled.
#[tauri::command]
pub async fn choose_export_path(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, ExportState>,
    default_name: String,
    ext: String,
) -> Result<Option<String>, String> {
    if !EXPORT_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!("unsupported export type: {ext}"));
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("导出")
        .set_file_name(default_name)
        .add_filter(ext.to_uppercase(), &[ext.as_str()])
        .set_parent(&window)
        .save_file(move |picked| {
            let _ = tx.send(picked);
        });
    let Some(picked) = rx
        .await
        .map_err(|_| "the save dialog closed unexpectedly".to_string())?
    else {
        return Ok(None);
    };
    let mut path = picked
        .into_path()
        .map_err(|e| format!("invalid export path: {e}"))?;
    let has_ext = path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case(&ext));
    if !has_ext {
        let mut name = path.file_name().unwrap_or_default().to_os_string();
        name.push(".");
        name.push(&ext);
        path.set_file_name(name);
    }
    state.allow(canonicalize_lenient(&path)?);
    Ok(Some(path_string(&path)))
}

/// Writes an HTML or Markdown export to a path chosen through `choose_export_path`.
/// Not recorded as the app's own write, so an export into the vault shows up as a new file.
#[tauri::command]
pub async fn write_export(
    state: State<'_, ExportState>,
    path: String,
    content: String,
) -> Result<(), String> {
    let target = state.take(&path)?;
    blocking(move || {
        atomic_write(&target, content.as_bytes()).map_err(|e| err_str("cannot write", &target, e))
    })
    .await
}
