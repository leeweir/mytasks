//! Vault state, persisted configuration and filesystem commands.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::watcher::VaultWatcher;

/// Name of the attachments directory inside the vault (excluded from listings).
pub const ATTACHMENTS_DIR: &str = "attachments";

pub type ContentHash = [u8; 32];

/// path → sha256 of the content most recently written by the app.
pub type WrittenHashes = Arc<Mutex<HashMap<PathBuf, ContentHash>>>;

#[derive(Default)]
pub struct AppState {
    vault: Mutex<Option<PathBuf>>,
    written: WrittenHashes,
    watcher: Mutex<Option<VaultWatcher>>,
}

#[derive(Serialize, Deserialize, Default)]
struct Config {
    vault: Option<String>,
}

#[derive(Serialize)]
pub struct VaultFile {
    path: String,
    rel: String,
    content: String,
    mtime: f64,
}

#[derive(Serialize)]
pub struct VaultListing {
    files: Vec<VaultFile>,
    dirs: Vec<String>,
}

pub fn hash_bytes(bytes: &[u8]) -> ContentHash {
    let digest = Sha256::digest(bytes);
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

/// Canonical form of a (possibly not yet existing) file path: the parent directory is
/// canonicalized so the key matches the paths reported by FSEvents.
pub fn normalize_path(path: &Path) -> PathBuf {
    if let Ok(p) = fs::canonicalize(path) {
        return p;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => fs::canonicalize(parent)
            .map(|p| p.join(name))
            .unwrap_or_else(|_| path.to_path_buf()),
        _ => path.to_path_buf(),
    }
}

/// True when `rel` (relative to the vault root) lies in a hidden or attachments directory.
pub fn is_excluded_rel(rel: &Path) -> bool {
    rel.components().any(|c| match c {
        Component::Normal(name) => {
            let name = name.to_string_lossy();
            name.starts_with('.') || name == ATTACHMENTS_DIR
        }
        _ => false,
    })
}

pub fn is_markdown(path: &Path) -> bool {
    path.extension()
        .map(|e| e.eq_ignore_ascii_case("md"))
        .unwrap_or(false)
}

fn posix_rel(path: &Path) -> String {
    path.components()
        .filter_map(|c| match c {
            Component::Normal(n) => Some(n.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn err_str(context: &str, path: &Path, e: impl std::fmt::Display) -> String {
    format!("{context} {}: {e}", path.display())
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|d| d.join("config.json"))
        .map_err(|e| format!("cannot resolve app config dir: {e}"))
}

fn load_config(app: &AppHandle) -> Config {
    config_path(app)
        .ok()
        .and_then(|p| fs::read(p).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_config(app: &AppHandle, config: &Config) -> Result<(), String> {
    let path = config_path(app)?;
    let json = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
    atomic_write(&path, &json).map_err(|e| err_str("cannot write", &path, e))
}

/// Writes `bytes` to a temp file next to `path`, then renames it over `path`.
fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let dir = target
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    let name = target
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
    fs::create_dir_all(dir)?;

    let tmp = dir.join(format!(
        ".{}.{}-{}.tmp",
        name.to_string_lossy(),
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if let Ok(meta) = fs::metadata(&target) {
            fs::set_permissions(&tmp, meta.permissions())?;
        }
        fs::rename(&tmp, &target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

impl AppState {
    fn vault(&self) -> Result<PathBuf, String> {
        self.vault
            .lock()
            .clone()
            .ok_or_else(|| "no vault selected".to_string())
    }

    fn record_write(&self, path: &Path, bytes: &[u8]) {
        self.written
            .lock()
            .insert(normalize_path(path), hash_bytes(bytes));
    }

    /// Makes `vault` the active vault: grants asset access and (re)starts the watcher.
    fn activate(&self, app: &AppHandle, vault: PathBuf) -> Result<(), String> {
        app.asset_protocol_scope()
            .allow_directory(&vault, true)
            .map_err(|e| format!("cannot allow asset access to {}: {e}", vault.display()))?;
        let mut watcher = self.watcher.lock();
        // Stop the previous watcher before starting the new one.
        *watcher = None;
        *watcher = Some(VaultWatcher::start(
            app.clone(),
            vault.clone(),
            self.written.clone(),
        )?);
        *self.vault.lock() = Some(vault);
        Ok(())
    }
}

/// Restores the persisted vault at startup (if it still exists).
pub fn restore_vault(app: &AppHandle) {
    let Some(stored) = load_config(app).vault else {
        return;
    };
    let Ok(vault) = fs::canonicalize(&stored) else {
        eprintln!("tasks: stored vault {stored} is not accessible");
        return;
    };
    if let Err(e) = app.state::<AppState>().activate(app, vault) {
        eprintln!("tasks: cannot activate vault {stored}: {e}");
    }
}

/// Joins a vault-relative path, rejecting absolute paths and `..`.
fn vault_join(vault: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    let valid = !rel.is_empty()
        && rel_path
            .components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    if !valid {
        return Err(format!("invalid vault-relative path: {rel}"));
    }
    Ok(vault.join(rel_path))
}

fn walk(
    root: &Path,
    dir: &Path,
    files: &mut Vec<VaultFile>,
    dirs: &mut Vec<String>,
) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| err_str("cannot read directory", dir, e))?;
    for entry in entries {
        let entry = entry.map_err(|e| err_str("cannot read directory", dir, e))?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        // Follow symlinks for files only; never recurse into symlinked dirs (cycles).
        let is_dir = file_type.is_dir();
        let is_file = if file_type.is_symlink() {
            fs::metadata(&path).map(|m| m.is_file()).unwrap_or(false)
        } else {
            file_type.is_file()
        };
        let rel = path.strip_prefix(root).unwrap_or(&path);
        if is_dir {
            if name_str == ATTACHMENTS_DIR {
                continue;
            }
            dirs.push(posix_rel(rel));
            walk(root, &path, files, dirs)?;
        } else if is_file && is_markdown(&path) {
            let bytes = match fs::read(&path) {
                Ok(b) => b,
                Err(e) => {
                    eprintln!("tasks: skipping unreadable {}: {e}", path.display());
                    continue;
                }
            };
            let mtime = fs::metadata(&path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as f64)
                .unwrap_or(0.0);
            files.push(VaultFile {
                path: path_string(&path),
                rel: posix_rel(rel),
                content: String::from_utf8_lossy(&bytes).into_owned(),
                mtime,
            });
        }
    }
    Ok(())
}

/// POSIX relative path from directory `from_dir` to `to` (both absolute, canonical).
fn relative_posix(from_dir: &Path, to: &Path) -> String {
    let from: Vec<Component> = from_dir.components().collect();
    let target: Vec<Component> = to.components().collect();
    let common = from
        .iter()
        .zip(target.iter())
        .take_while(|(a, b)| a == b)
        .count();
    let mut parts: Vec<String> = std::iter::repeat_n("..".to_string(), from.len() - common).collect();
    parts.extend(
        target[common..]
            .iter()
            .map(|c| c.as_os_str().to_string_lossy().into_owned()),
    );
    parts.join("/")
}

/// Atomically claims a unique file name `stem.ext`, `stem-1.ext`, … in `dir`.
fn claim_unique(dir: &Path, stem: &str, ext: &str) -> Result<PathBuf, String> {
    for n in 0u32.. {
        let name = match (n, ext.is_empty()) {
            (0, true) => stem.to_string(),
            (0, false) => format!("{stem}.{ext}"),
            (_, true) => format!("{stem}-{n}"),
            (_, false) => format!("{stem}-{n}.{ext}"),
        };
        let candidate = dir.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(_) => return Ok(candidate),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(err_str("cannot create", &candidate, e)),
        }
    }
    unreachable!("u32 range exhausted while choosing an attachment name")
}

fn attachments_dir(vault: &Path) -> Result<PathBuf, String> {
    let dir = vault.join(ATTACHMENTS_DIR);
    fs::create_dir_all(&dir).map_err(|e| err_str("cannot create", &dir, e))?;
    Ok(dir)
}

fn attachment_result(for_file: &str, attachment: &Path) -> String {
    let for_file = normalize_path(Path::new(for_file));
    let from_dir = for_file.parent().unwrap_or(Path::new("/"));
    relative_posix(from_dir, &normalize_path(attachment))
}

fn sanitize_ext(ext: &str) -> String {
    let clean: String = ext
        .trim_start_matches('.')
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>()
        .to_ascii_lowercase();
    if clean.is_empty() {
        "png".to_string()
    } else {
        clean
    }
}

pub fn save_attachment_bytes_impl(
    state: &AppState,
    for_file: &str,
    bytes: &[u8],
    ext: &str,
) -> Result<String, String> {
    let dir = attachments_dir(&state.vault()?)?;
    let stem = format!("pasted-{}", chrono::Local::now().format("%Y%m%d-%H%M%S"));
    let dest = claim_unique(&dir, &stem, &sanitize_ext(ext))?;
    if let Err(e) = fs::write(&dest, bytes) {
        let _ = fs::remove_file(&dest);
        return Err(err_str("cannot write", &dest, e));
    }
    Ok(attachment_result(for_file, &dest))
}

// ───────────────────────────── commands ─────────────────────────────

#[tauri::command]
pub async fn get_vault(state: State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(state.vault.lock().as_deref().map(path_string))
}

#[tauri::command]
pub async fn set_vault(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let vault = fs::canonicalize(&path).map_err(|e| format!("cannot open vault {path}: {e}"))?;
    if !vault.is_dir() {
        return Err(format!("{path} is not a directory"));
    }
    save_config(
        &app,
        &Config {
            vault: Some(path_string(&vault)),
        },
    )?;
    state.activate(&app, vault)
}

#[tauri::command]
pub async fn list_vault(state: State<'_, AppState>) -> Result<VaultListing, String> {
    let vault = state.vault()?;
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    walk(&vault, &vault, &mut files, &mut dirs)?;
    files.sort_by(|a, b| a.rel.cmp(&b.rel));
    dirs.sort();
    Ok(VaultListing { files, dirs })
}

#[tauri::command]
pub async fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("cannot read {path}: {e}"))
}

#[tauri::command]
pub async fn write_file(
    state: State<'_, AppState>,
    path: String,
    content: String,
) -> Result<(), String> {
    let path = PathBuf::from(path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| err_str("cannot create", parent, e))?;
    }
    state.record_write(&path, content.as_bytes());
    atomic_write(&path, content.as_bytes()).map_err(|e| err_str("cannot write", &path, e))
}

#[tauri::command]
pub async fn create_file(
    state: State<'_, AppState>,
    rel: String,
    content: String,
) -> Result<String, String> {
    let path = vault_join(&state.vault()?, &rel)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| err_str("cannot create", parent, e))?;
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| err_str("cannot create", &path, e))?;
    state.record_write(&path, content.as_bytes());
    file.write_all(content.as_bytes())
        .map_err(|e| err_str("cannot write", &path, e))?;
    Ok(path_string(&path))
}

#[tauri::command]
pub async fn create_dir(state: State<'_, AppState>, rel: String) -> Result<(), String> {
    let path = vault_join(&state.vault()?, &rel)?;
    fs::create_dir_all(&path).map_err(|e| err_str("cannot create", &path, e))
}

#[tauri::command]
pub async fn rename_path(
    state: State<'_, AppState>,
    from: String,
    to_rel: String,
) -> Result<String, String> {
    let from = PathBuf::from(from);
    let to = vault_join(&state.vault()?, &to_rel)?;
    // Allow case-only renames on case-insensitive volumes.
    let same_entry = fs::canonicalize(&from).ok() == fs::canonicalize(&to).ok();
    if to.exists() && !same_entry {
        return Err(format!("{} already exists", to.display()));
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| err_str("cannot create", parent, e))?;
    }
    {
        let mut written = state.written.lock();
        if let Some(hash) = written.remove(&normalize_path(&from)) {
            written.insert(normalize_path(&to), hash);
        }
    }
    fs::rename(&from, &to).map_err(|e| err_str("cannot rename", &from, e))?;
    Ok(path_string(&to))
}

#[tauri::command]
pub async fn trash_path(state: State<'_, AppState>, path: String) -> Result<(), String> {
    use trash::macos::{DeleteMethod, TrashContextExtMacos};
    let mut ctx = trash::TrashContext::default();
    // NSFileManager avoids the Finder Apple Events permission prompt.
    ctx.set_delete_method(DeleteMethod::NsFileManager);
    ctx.delete(&path)
        .map_err(|e| format!("cannot move {path} to Trash: {e}"))?;
    state.written.lock().remove(&normalize_path(Path::new(&path)));
    Ok(())
}

#[tauri::command]
pub async fn save_attachment(
    state: State<'_, AppState>,
    for_file: String,
    src_path: String,
) -> Result<String, String> {
    let src = PathBuf::from(&src_path);
    let dir = attachments_dir(&state.vault()?)?;
    let file_name = src
        .file_name()
        .ok_or_else(|| format!("invalid attachment path: {src_path}"))?;
    let name_path = Path::new(file_name);
    let stem = name_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "attachment".to_string());
    let ext = name_path
        .extension()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let dest = claim_unique(&dir, &stem, &ext)?;
    if let Err(e) = fs::copy(&src, &dest) {
        let _ = fs::remove_file(&dest);
        return Err(format!("cannot copy {src_path}: {e}"));
    }
    Ok(attachment_result(&for_file, &dest))
}

/// Raw-body variant: body = image bytes, headers `x-for-file` (URI-encoded) and `x-ext`.
#[tauri::command]
pub async fn save_attachment_bytes(
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("save_attachment_bytes expects a raw byte body".to_string());
    };
    let header = |name: &str| -> Result<String, String> {
        let value = request
            .headers()
            .get(name)
            .ok_or_else(|| format!("missing header {name}"))?
            .to_str()
            .map_err(|e| format!("invalid header {name}: {e}"))?;
        percent_encoding::percent_decode_str(value)
            .decode_utf8()
            .map(|s| s.into_owned())
            .map_err(|e| format!("invalid header {name}: {e}"))
    };
    let for_file = header("x-for-file")?;
    let ext = header("x-ext")?;
    save_attachment_bytes_impl(&state, &for_file, bytes, &ext)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths() {
        assert_eq!(
            relative_posix(Path::new("/v/notes"), Path::new("/v/attachments/x.png")),
            "../attachments/x.png"
        );
        assert_eq!(
            relative_posix(Path::new("/v"), Path::new("/v/attachments/x.png")),
            "attachments/x.png"
        );
        assert_eq!(
            relative_posix(Path::new("/v/a/b"), Path::new("/v/attachments/x.png")),
            "../../attachments/x.png"
        );
    }

    #[test]
    fn unique_names() {
        let dir = std::env::temp_dir().join(format!("tasks-unique-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let a = claim_unique(&dir, "img", "png").unwrap();
        let b = claim_unique(&dir, "img", "png").unwrap();
        let c = claim_unique(&dir, "img", "png").unwrap();
        assert_eq!(a.file_name().unwrap(), "img.png");
        assert_eq!(b.file_name().unwrap(), "img-1.png");
        assert_eq!(c.file_name().unwrap(), "img-2.png");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn vault_join_rejects_escape() {
        assert!(vault_join(Path::new("/v"), "../x.md").is_err());
        assert!(vault_join(Path::new("/v"), "/x.md").is_err());
        assert!(vault_join(Path::new("/v"), "").is_err());
        assert_eq!(vault_join(Path::new("/v"), "a/b.md").unwrap(), Path::new("/v/a/b.md"));
    }

    #[test]
    fn exclusions() {
        assert!(is_excluded_rel(Path::new(".obsidian/x.md")));
        assert!(is_excluded_rel(Path::new("attachments/x.md")));
        assert!(is_excluded_rel(Path::new("a/.x.md.1-2.tmp")));
        assert!(!is_excluded_rel(Path::new("a/b.md")));
    }
}
