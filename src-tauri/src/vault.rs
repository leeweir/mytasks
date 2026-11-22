//! Vault state, persisted configuration, path validation and filesystem commands.

use std::collections::HashMap;
use std::ffi::{CString, OsStr};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::tracker::WriteTracker;
use crate::watcher::VaultWatcher;

/// Name of the attachments directory inside the vault (excluded from listings).
pub const ATTACHMENTS_DIR: &str = "attachments";

/// Error prefix of `write_file` when the disk no longer holds the expected content.
const CONFLICT_PREFIX: &str = "CONFLICT:";
/// Error prefix of `read_file` for files that are not valid UTF-8.
const NOT_UTF8_PREFIX: &str = "NOT_UTF8:";

/// Extensions `open_vault_path` refuses because opening them runs code or installs something.
const LAUNCHABLE_EXTENSIONS: &[&str] = &[
    "app", "command", "sh", "tool", "terminal", "workflow", "pkg", "mpkg", "scpt", "scptd",
    "jar", "prefpane", "saver", "fileloc", "inetloc", "webloc", "py", "pyc",
];

/// How long a file dropped onto the window may still be imported as an attachment.
const DROP_TTL: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct AppState {
    vault: Mutex<Option<PathBuf>>,
    tracker: Arc<WriteTracker>,
    watcher: Mutex<Option<VaultWatcher>>,
    /// Canonical paths of files dropped onto the window, with the time of the drop; each
    /// may be imported once through `save_attachment` within `DROP_TTL`.
    dropped: Mutex<HashMap<PathBuf, Instant>>,
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
pub struct SkippedEntry {
    rel: String,
    reason: String,
}

#[derive(Serialize, Default)]
pub struct VaultListing {
    files: Vec<VaultFile>,
    dirs: Vec<String>,
    skipped: Vec<SkippedEntry>,
}

/// Current state of one file; `content` is None when the file is gone, excluded,
/// not Markdown, unreadable or not UTF-8.
#[derive(Serialize)]
pub struct VaultFileUpdate {
    path: String,
    rel: String,
    mtime: f64,
    content: Option<String>,
    /// Why an existing Markdown file cannot be loaded (same reasons as the listing's
    /// `skipped`); None when it loaded, is gone, excluded or not Markdown.
    skipped: Option<String>,
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

pub fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

pub fn err_str(context: &str, path: &Path, e: impl std::fmt::Display) -> String {
    format!("{context} {}: {e}", path.display())
}

fn mtime_ms(meta: &Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// Runs filesystem work off the async runtime's worker threads.
pub async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("background task failed: {e}"))?
}

// ───────────────────────────── path validation ─────────────────────────────

/// Canonicalizes the longest existing ancestor of `path` and appends the missing
/// components, which cannot be symlinks because they do not exist.
pub fn canonicalize_lenient(path: &Path) -> Result<PathBuf, String> {
    let mut missing: Vec<&OsStr> = Vec::new();
    let mut current = path;
    loop {
        match fs::canonicalize(current) {
            Ok(mut resolved) => {
                resolved.extend(missing.iter().rev());
                return Ok(resolved);
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                if fs::symlink_metadata(current).is_ok() {
                    return Err(format!("{} is a dangling symlink", current.display()));
                }
                let (Some(parent), Some(name)) = (current.parent(), current.file_name()) else {
                    return Err(err_str("cannot resolve", path, e));
                };
                missing.push(name);
                current = parent;
            }
            Err(e) => return Err(err_str("cannot resolve", path, e)),
        }
    }
}

fn require_inside(vault: &Path, resolved: &Path, original: &Path) -> Result<(), String> {
    if resolved.starts_with(vault) && resolved != vault {
        Ok(())
    } else {
        Err(format!("{} is not inside the vault", original.display()))
    }
}

/// The directory entry `path` names, strictly inside `vault` (a final symlink is not
/// followed, so renaming or trashing it affects the link itself).
pub fn vault_entry(vault: &Path, path: &Path) -> Result<PathBuf, String> {
    let lexically_valid =
        path.is_absolute() && !path.components().any(|c| matches!(c, Component::ParentDir));
    let (true, Some(parent), Some(name)) = (lexically_valid, path.parent(), path.file_name())
    else {
        return Err(format!("invalid path: {}", path.display()));
    };
    let entry = canonicalize_lenient(parent)?.join(name);
    require_inside(vault, &entry, path)?;
    Ok(entry)
}

/// The file `path` refers to after following symlinks, strictly inside `vault`. A path
/// that does not exist yet resolves to where it would be created.
pub fn vault_target(vault: &Path, path: &Path) -> Result<PathBuf, String> {
    let entry = vault_entry(vault, path)?;
    let target = match fs::symlink_metadata(&entry) {
        Ok(meta) if meta.file_type().is_symlink() => {
            fs::canonicalize(&entry).map_err(|e| err_str("cannot resolve", path, e))?
        }
        _ => entry,
    };
    require_inside(vault, &target, path)?;
    Ok(target)
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

// ───────────────────────────── config & atomic writes ─────────────────────────────

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

fn c_path(path: &Path) -> io::Result<CString> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))
}

/// Copies extended attributes (Finder tags, …) and the ACL of `from` onto `to`.
fn copy_xattrs_and_acl(from: &Path, to: &Path) -> io::Result<()> {
    let (from, to) = (c_path(from)?, c_path(to)?);
    // SAFETY: both arguments are valid NUL-terminated paths; a null state is allowed.
    let rc = unsafe {
        libc::copyfile(
            from.as_ptr(),
            to.as_ptr(),
            std::ptr::null_mut(),
            libc::COPYFILE_XATTR | libc::COPYFILE_ACL,
        )
    };
    if rc < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Sets the creation date (birthtime) of `to` to the one recorded in `meta`.
fn set_creation_time(meta: &Metadata, to: &Path) -> io::Result<()> {
    use std::os::macos::fs::MetadataExt as _;
    let to = c_path(to)?;
    let mut attrs = libc::attrlist {
        bitmapcount: libc::ATTR_BIT_MAP_COUNT,
        reserved: 0,
        commonattr: libc::ATTR_CMN_CRTIME,
        volattr: 0,
        dirattr: 0,
        fileattr: 0,
        forkattr: 0,
    };
    let mut created = libc::timespec {
        tv_sec: meta.st_birthtime(),
        tv_nsec: meta.st_birthtime_nsec(),
    };
    // SAFETY: `attrs` requests exactly one attribute, ATTR_CMN_CRTIME, whose value is
    // the single timespec in the buffer of the given size.
    let rc = unsafe {
        libc::setattrlist(
            to.as_ptr(),
            (&mut attrs as *mut libc::attrlist).cast(),
            (&mut created as *mut libc::timespec).cast(),
            std::mem::size_of::<libc::timespec>(),
            0,
        )
    };
    if rc < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn fsync_dir(dir: &Path) -> io::Result<()> {
    let dir = File::open(dir)?;
    // SAFETY: the descriptor stays open for the duration of the call.
    if unsafe { libc::fsync(dir.as_raw_fd()) } < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Writes `bytes` to a temp file next to `path`, carries over the old file's
/// permissions, creation date, extended attributes and ACL, then renames it over `path`.
/// Hard links to the old file keep the old content: replacing by rename cannot
/// preserve them.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
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
            // Metadata loss must not block saving the content itself.
            if let Err(e) = copy_xattrs_and_acl(&target, &tmp) {
                eprintln!("tasks: cannot carry over metadata of {}: {e}", target.display());
            }
            if let Err(e) = set_creation_time(&meta, &tmp) {
                eprintln!("tasks: cannot carry over creation date of {}: {e}", target.display());
            }
        }
        fs::rename(&tmp, &target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
        return result;
    }
    // The content is in place; a failed directory sync must not report the save as failed.
    if let Err(e) = fsync_dir(dir) {
        eprintln!("tasks: cannot sync directory {}: {e}", dir.display());
    }
    Ok(())
}

// ───────────────────────────── state ─────────────────────────────

impl AppState {
    fn vault(&self) -> Result<PathBuf, String> {
        self.vault
            .lock()
            .clone()
            .ok_or_else(|| "no vault selected".to_string())
    }

    pub fn current_vault(&self) -> Option<PathBuf> {
        self.vault.lock().clone()
    }

    /// Makes `vault` active: the new watcher starts first, the config is persisted (when
    /// asked), and only then the old watcher and vault are replaced. Any failure leaves
    /// the previous vault fully active.
    fn activate(&self, app: &AppHandle, vault: PathBuf, persist: bool) -> Result<(), String> {
        let mut watcher = self.watcher.lock();
        let started = VaultWatcher::start(app.clone(), vault.clone(), self.tracker.clone())?;
        if persist {
            save_config(
                app,
                &Config {
                    vault: Some(path_string(&vault)),
                },
            )?;
        }
        *watcher = Some(started);
        *self.vault.lock() = Some(vault);
        Ok(())
    }

    /// Remembers the files of a drag-and-drop onto the window.
    pub fn remember_dropped(&self, paths: &[PathBuf]) {
        let now = Instant::now();
        let mut dropped = self.dropped.lock();
        dropped.retain(|_, at| now.duration_since(*at) < DROP_TTL);
        dropped.extend(paths.iter().filter_map(|p| fs::canonicalize(p).ok()).map(|p| (p, now)));
    }

    /// Consumes the permission to import the dropped file `path` (canonical).
    fn take_dropped(&self, path: &Path) -> bool {
        self.dropped
            .lock()
            .remove(path)
            .is_some_and(|at| at.elapsed() < DROP_TTL)
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
    if let Err(e) = app.state::<AppState>().activate(app, vault, false) {
        eprintln!("tasks: cannot activate vault {stored}: {e}");
    }
}

// ───────────────────────────── listing & reading ─────────────────────────────

fn list_vault_impl(vault: &Path) -> Result<VaultListing, String> {
    let entries = fs::read_dir(vault).map_err(|e| err_str("cannot read directory", vault, e))?;
    let mut listing = VaultListing::default();
    walk(vault, vault, entries, &mut listing);
    listing.files.sort_by(|a, b| a.rel.cmp(&b.rel));
    listing.dirs.sort();
    listing.skipped.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(listing)
}

fn skip(listing: &mut VaultListing, path: &Path, rel: &Path, reason: String) {
    eprintln!("tasks: skipping {}: {reason}", path.display());
    listing.skipped.push(SkippedEntry {
        rel: posix_rel(rel),
        reason,
    });
}

const REASON_NOT_UTF8: &str = "不是 UTF-8 编码";
const REASON_OUTSIDE: &str = "链接指向任务文件夹之外";

fn unreadable_reason(e: &io::Error) -> String {
    format!("无法读取：{e}")
}

/// Collects Markdown files and directories below `dir`. Unreadable subdirectories and
/// files that cannot be read as UTF-8 are reported in `skipped` instead of failing.
fn walk(root: &Path, dir: &Path, entries: fs::ReadDir, listing: &mut VaultListing) {
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                let rel = dir.strip_prefix(root).unwrap_or(dir);
                skip(listing, dir, rel, unreadable_reason(&e));
                continue;
            }
        };
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let rel = path.strip_prefix(root).unwrap_or(&path);
        // Never recurse into symlinked directories (cycles, escaping the vault).
        if file_type.is_dir() {
            if name == ATTACHMENTS_DIR {
                continue;
            }
            match fs::read_dir(&path) {
                Ok(children) => {
                    listing.dirs.push(posix_rel(rel));
                    walk(root, &path, children, listing);
                }
                Err(e) => skip(listing, &path, rel, unreadable_reason(&e)),
            }
            continue;
        }
        if !is_markdown(&path) {
            continue;
        }
        if file_type.is_symlink() {
            match fs::canonicalize(&path) {
                Ok(target) if target.starts_with(root) => {}
                Ok(_) => {
                    skip(listing, &path, rel, REASON_OUTSIDE.to_string());
                    continue;
                }
                // Dangling link.
                Err(_) => continue,
            }
        }
        let meta = match fs::metadata(&path) {
            Ok(meta) if meta.is_file() => meta,
            _ => continue,
        };
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) => {
                skip(listing, &path, rel, unreadable_reason(&e));
                continue;
            }
        };
        let content = match String::from_utf8(bytes) {
            Ok(content) => content,
            Err(_) => {
                skip(listing, &path, rel, REASON_NOT_UTF8.to_string());
                continue;
            }
        };
        listing.files.push(VaultFile {
            path: path_string(&path),
            rel: posix_rel(rel),
            content,
            mtime: mtime_ms(&meta),
        });
    }
}

fn read_vault_files_impl(vault: &Path, paths: &[String]) -> Result<Vec<VaultFileUpdate>, String> {
    paths
        .iter()
        .map(|raw| {
            let path = Path::new(raw);
            let lexically_inside = path.is_absolute()
                && !path.components().any(|c| matches!(c, Component::ParentDir))
                && path.starts_with(vault)
                && path != vault;
            if !lexically_inside {
                return Err(format!("{raw} is not inside the vault"));
            }
            let rel = path.strip_prefix(vault).unwrap_or(path);
            let mut update = VaultFileUpdate {
                path: raw.clone(),
                rel: posix_rel(rel),
                mtime: 0.0,
                content: None,
                skipped: None,
            };
            if is_excluded_rel(rel) || !is_markdown(path) {
                return Ok(update);
            }
            let Ok(target) = vault_target(vault, path) else {
                // An existing file reached through a symlink that leaves the vault.
                if fs::metadata(path).is_ok() {
                    update.skipped = Some(REASON_OUTSIDE.to_string());
                }
                return Ok(update);
            };
            let Ok(meta) = fs::metadata(&target) else {
                return Ok(update);
            };
            if !meta.is_file() {
                return Ok(update);
            }
            match fs::read(&target).map(String::from_utf8) {
                Ok(Ok(content)) => {
                    update.mtime = mtime_ms(&meta);
                    update.content = Some(content);
                }
                Ok(Err(_)) => update.skipped = Some(REASON_NOT_UTF8.to_string()),
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => update.skipped = Some(unreadable_reason(&e)),
            }
            Ok(update)
        })
        .collect()
}

fn read_file_impl(vault: &Path, path: &str) -> Result<String, String> {
    let target = vault_target(vault, Path::new(path))?;
    let bytes = fs::read(&target).map_err(|e| format!("cannot read {path}: {e}"))?;
    String::from_utf8(bytes).map_err(|_| format!("{NOT_UTF8_PREFIX} {path} is not valid UTF-8"))
}

// ───────────────────────────── writing ─────────────────────────────

fn write_file_impl(
    vault: &Path,
    tracker: &WriteTracker,
    path: &Path,
    content: &str,
    expected: Option<&str>,
) -> Result<(), String> {
    let target = vault_target(vault, path)?;
    if !is_markdown(path) || !is_markdown(&target) {
        return Err(format!("{} is not a Markdown file", path.display()));
    }
    let lock = tracker.lock_for(&target);
    let _guard = lock.lock();
    if let Some(expected) = expected {
        match fs::read(&target) {
            Ok(current) if current == expected.as_bytes() => {}
            Ok(_) => {
                return Err(format!(
                    "{CONFLICT_PREFIX} {} was changed by another program",
                    path.display()
                ))
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                return Err(format!("{CONFLICT_PREFIX} {} no longer exists", path.display()))
            }
            Err(e) => return Err(err_str("cannot read", path, e)),
        }
    }
    let previous = tracker.record(&target, content.as_bytes());
    atomic_write(&target, content.as_bytes()).map_err(|e| {
        tracker.restore(&target, previous);
        err_str("cannot write", path, e)
    })
}

fn create_file_impl(
    vault: &Path,
    tracker: &WriteTracker,
    rel: &str,
    content: &str,
) -> Result<String, String> {
    let path = vault_join(vault, rel)?;
    let entry = vault_entry(vault, &path)?;
    if !is_markdown(&entry) {
        return Err(format!("{rel} is not a Markdown file"));
    }
    if let Some(parent) = entry.parent() {
        fs::create_dir_all(parent).map_err(|e| err_str("cannot create", parent, e))?;
    }
    let lock = tracker.lock_for(&entry);
    let _guard = lock.lock();
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&entry)
        .map_err(|e| err_str("cannot create", &path, e))?;
    let previous = tracker.record(&entry, content.as_bytes());
    if let Err(e) = file.write_all(content.as_bytes()) {
        tracker.restore(&entry, previous);
        drop(file);
        let _ = fs::remove_file(&entry);
        return Err(err_str("cannot write", &path, e));
    }
    Ok(path_string(&path))
}

fn same_inode(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino()
}

fn rename_path_impl(
    vault: &Path,
    tracker: &WriteTracker,
    from: &str,
    to_rel: &str,
) -> Result<String, String> {
    let from_entry = vault_entry(vault, Path::new(from))?;
    let from_meta = fs::symlink_metadata(&from_entry).map_err(|e| format!("cannot rename {from}: {e}"))?;
    let to = vault_join(vault, to_rel)?;
    let to_entry = vault_entry(vault, &to)?;
    // Allow case-only renames on case-insensitive volumes.
    if let Ok(to_meta) = fs::symlink_metadata(&to_entry) {
        if !same_inode(&from_meta, &to_meta) {
            return Err(format!("{} already exists", to.display()));
        }
    }
    if let Some(parent) = to_entry.parent() {
        fs::create_dir_all(parent).map_err(|e| err_str("cannot create", parent, e))?;
    }
    let lock = tracker.lock_for(&from_entry);
    let _guard = lock.lock();
    tracker.rename(&from_entry, &to_entry);
    if let Err(e) = fs::rename(&from_entry, &to_entry) {
        tracker.rename(&to_entry, &from_entry);
        return Err(err_str("cannot rename", Path::new(from), e));
    }
    Ok(path_string(&to))
}

/// True when opening `path` with its default application would run code or install something.
fn is_launchable(path: &Path, meta: &Metadata) -> bool {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase());
    if let Some(ext) = &ext {
        if LAUNCHABLE_EXTENSIONS.contains(&ext.as_str()) {
            return true;
        }
    }
    if meta.is_dir() {
        // Bundles (plug-ins, packages, …) are directories with an extension.
        return ext.is_some();
    }
    meta.permissions().mode() & 0o111 != 0
}

fn open_target(vault: &Path, path: &str) -> Result<PathBuf, String> {
    let target = vault_target(vault, Path::new(path))?;
    let meta = fs::metadata(&target).map_err(|e| format!("cannot open {path}: {e}"))?;
    if is_launchable(&target, &meta) {
        return Err(format!("refusing to open {path}: it could run a program"));
    }
    Ok(target)
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
    let dir = vault_target(vault, &vault.join(ATTACHMENTS_DIR))?;
    fs::create_dir_all(&dir).map_err(|e| err_str("cannot create", &dir, e))?;
    Ok(dir)
}

/// Path of `attachment` relative to the directory of `for_file` (a validated vault entry).
fn attachment_result(for_file: &Path, attachment: &Path) -> String {
    let from_dir = for_file.parent().unwrap_or(Path::new("/"));
    relative_posix(from_dir, attachment)
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

fn save_attachment_bytes_impl(
    vault: &Path,
    for_file: &str,
    bytes: &[u8],
    ext: &str,
) -> Result<String, String> {
    let for_file = vault_entry(vault, Path::new(for_file))?;
    let dir = attachments_dir(vault)?;
    let stem = format!("pasted-{}", chrono::Local::now().format("%Y%m%d-%H%M%S"));
    let dest = claim_unique(&dir, &stem, &sanitize_ext(ext))?;
    if let Err(e) = fs::write(&dest, bytes) {
        let _ = fs::remove_file(&dest);
        return Err(err_str("cannot write", &dest, e));
    }
    Ok(attachment_result(&for_file, &dest))
}

fn save_attachment_impl(vault: &Path, for_file: &str, src: &Path) -> Result<String, String> {
    let for_file = vault_entry(vault, Path::new(for_file))?;
    let dir = attachments_dir(vault)?;
    let name_path = Path::new(src.file_name().unwrap_or(OsStr::new("attachment")));
    let stem = name_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "attachment".to_string());
    let ext = name_path
        .extension()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let dest = claim_unique(&dir, &stem, &ext)?;
    if let Err(e) = fs::copy(src, &dest) {
        let _ = fs::remove_file(&dest);
        return Err(err_str("cannot copy", src, e));
    }
    Ok(attachment_result(&for_file, &dest))
}

// ───────────────────────────── commands ─────────────────────────────

#[tauri::command]
pub async fn get_vault(state: State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(state.vault.lock().as_deref().map(path_string))
}

/// Shows the folder picker and activates the chosen folder; None when cancelled.
#[tauri::command]
pub async fn choose_vault(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("选择任务文件夹")
        .set_parent(&window)
        .pick_folder(move |picked| {
            let _ = tx.send(picked);
        });
    let Some(picked) = rx
        .await
        .map_err(|_| "the folder picker closed unexpectedly".to_string())?
    else {
        return Ok(None);
    };
    let picked = picked
        .into_path()
        .map_err(|e| format!("invalid folder: {e}"))?;
    let vault = fs::canonicalize(&picked).map_err(|e| err_str("cannot open vault", &picked, e))?;
    if !vault.is_dir() {
        return Err(format!("{} is not a directory", picked.display()));
    }
    state.activate(&app, vault.clone(), true)?;
    Ok(Some(path_string(&vault)))
}

#[tauri::command]
pub async fn list_vault(state: State<'_, AppState>) -> Result<VaultListing, String> {
    let vault = state.vault()?;
    blocking(move || list_vault_impl(&vault)).await
}

#[tauri::command]
pub async fn read_vault_files(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<Vec<VaultFileUpdate>, String> {
    let vault = state.vault()?;
    blocking(move || read_vault_files_impl(&vault, &paths)).await
}

#[tauri::command]
pub async fn read_file(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let vault = state.vault()?;
    blocking(move || read_file_impl(&vault, &path)).await
}

/// Atomically replaces a Markdown file. With `expected`, fails with `CONFLICT:` unless
/// the file currently holds exactly that text.
#[tauri::command]
pub async fn write_file(
    state: State<'_, AppState>,
    path: String,
    content: String,
    expected: Option<String>,
) -> Result<(), String> {
    let vault = state.vault()?;
    let tracker = state.tracker.clone();
    blocking(move || {
        write_file_impl(&vault, &tracker, Path::new(&path), &content, expected.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn create_file(
    state: State<'_, AppState>,
    rel: String,
    content: String,
) -> Result<String, String> {
    let vault = state.vault()?;
    let tracker = state.tracker.clone();
    blocking(move || create_file_impl(&vault, &tracker, &rel, &content)).await
}

#[tauri::command]
pub async fn create_dir(state: State<'_, AppState>, rel: String) -> Result<(), String> {
    let vault = state.vault()?;
    blocking(move || {
        let path = vault_entry(&vault, &vault_join(&vault, &rel)?)?;
        fs::create_dir_all(&path).map_err(|e| err_str("cannot create", &path, e))
    })
    .await
}

#[tauri::command]
pub async fn rename_path(
    state: State<'_, AppState>,
    from: String,
    to_rel: String,
) -> Result<String, String> {
    let vault = state.vault()?;
    let tracker = state.tracker.clone();
    blocking(move || rename_path_impl(&vault, &tracker, &from, &to_rel)).await
}

#[tauri::command]
pub async fn trash_path(state: State<'_, AppState>, path: String) -> Result<(), String> {
    use trash::macos::{DeleteMethod, TrashContextExtMacos};
    let vault = state.vault()?;
    let tracker = state.tracker.clone();
    blocking(move || {
        let entry = vault_entry(&vault, Path::new(&path))?;
        let mut ctx = trash::TrashContext::default();
        // NSFileManager avoids the Finder Apple Events permission prompt.
        ctx.set_delete_method(DeleteMethod::NsFileManager);
        ctx.delete(&entry)
            .map_err(|e| format!("cannot move {path} to Trash: {e}"))?;
        tracker.forget(&entry);
        Ok(())
    })
    .await
}

/// Opens a file inside the vault with its default application (never launchable types).
#[tauri::command]
pub async fn open_vault_path(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let vault = state.vault()?;
    blocking(move || {
        let target = open_target(&vault, &path)?;
        tauri_plugin_opener::open_path(&target, None::<&str>)
            .map_err(|e| format!("cannot open {path}: {e}"))
    })
    .await
}

/// Copies a file dropped onto the window into the vault's attachments directory.
#[tauri::command]
pub async fn save_attachment(
    state: State<'_, AppState>,
    for_file: String,
    src_path: String,
) -> Result<String, String> {
    let vault = state.vault()?;
    let src = fs::canonicalize(&src_path).map_err(|e| format!("cannot read {src_path}: {e}"))?;
    if !state.take_dropped(&src) {
        return Err(format!("{src_path} was not dropped onto the window"));
    }
    blocking(move || save_attachment_impl(&vault, &for_file, &src)).await
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
    let vault = state.vault()?;
    // The request only lends its body; the copy lets the write leave the async worker.
    let bytes = bytes.clone();
    blocking(move || save_attachment_bytes_impl(&vault, &for_file, &bytes, &ext)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    /// A fresh canonical directory under the system temp dir.
    fn temp_dir(name: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "tasks-{name}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(&dir).unwrap()
    }

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
        let dir = temp_dir("unique");
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

    #[test]
    fn walk_skips_unreadable_dir_and_non_utf8_file() {
        let vault = temp_dir("walk");
        fs::write(vault.join("ok.md"), "- [ ] a").unwrap();
        fs::write(vault.join("gbk.md"), [0xC4, 0xE3, 0xBA, 0xC3]).unwrap();
        let locked = vault.join("locked");
        fs::create_dir(&locked).unwrap();
        fs::write(locked.join("hidden.md"), "x").unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();

        let listing = list_vault_impl(&vault);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        let listing = listing.unwrap();

        let files: Vec<&str> = listing.files.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(files, ["ok.md"]);
        assert!(listing.dirs.is_empty());
        let skipped: Vec<&str> = listing.skipped.iter().map(|s| s.rel.as_str()).collect();
        assert_eq!(skipped, ["gbk.md", "locked"]);

        let err = read_file_impl(&vault, &path_string(&vault.join("gbk.md"))).unwrap_err();
        assert!(err.starts_with(NOT_UTF8_PREFIX), "{err}");
        fs::remove_dir_all(&vault).unwrap();
    }

    #[test]
    fn write_file_detects_conflicts() {
        let vault = temp_dir("cas");
        let tracker = WriteTracker::default();
        let file = vault.join("a.md");
        fs::write(&file, "old\r\n").unwrap();

        write_file_impl(&vault, &tracker, &file, "new", Some("old\r\n")).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "new");

        fs::write(&file, "external").unwrap();
        let err = write_file_impl(&vault, &tracker, &file, "mine", Some("new")).unwrap_err();
        assert!(err.starts_with(CONFLICT_PREFIX), "{err}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "external");

        fs::remove_file(&file).unwrap();
        let err = write_file_impl(&vault, &tracker, &file, "mine", Some("external")).unwrap_err();
        assert!(err.starts_with(CONFLICT_PREFIX), "{err}");
        assert!(!file.exists());

        write_file_impl(&vault, &tracker, &file, "recreated", None).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "recreated");
        assert!(write_file_impl(&vault, &tracker, &vault.join("a.txt"), "x", None).is_err());
        fs::remove_dir_all(&vault).unwrap();
    }

    #[test]
    fn path_validation_rejects_outside_root_and_symlink_escape() {
        let base = temp_dir("scope");
        let vault = base.join("vault");
        let outside = base.join("outside");
        fs::create_dir_all(vault.join("sub")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.md"), "secret").unwrap();
        symlink(&outside, vault.join("linkdir")).unwrap();
        symlink(outside.join("secret.md"), vault.join("link.md")).unwrap();

        assert!(vault_target(&vault, &vault.join("sub/new.md")).is_ok());
        assert!(vault_target(&vault, &vault.join("missing/dir/new.md")).is_ok());
        assert!(vault_target(&vault, &outside.join("secret.md")).is_err());
        assert!(vault_target(&vault, &vault).is_err());
        assert!(vault_entry(&vault, &vault).is_err());
        assert!(vault_target(&vault, &vault.join("sub/../../outside/secret.md")).is_err());
        assert!(vault_target(&vault, Path::new("sub/a.md")).is_err());
        assert!(vault_target(&vault, &vault.join("linkdir/secret.md")).is_err());
        assert!(vault_target(&vault, &vault.join("linkdir/new.md")).is_err());
        assert!(vault_target(&vault, &vault.join("link.md")).is_err());
        // The link itself may still be renamed or trashed.
        assert_eq!(vault_entry(&vault, &vault.join("link.md")).unwrap(), vault.join("link.md"));
        assert!(read_file_impl(&vault, &path_string(&vault.join("link.md"))).is_err());
        assert!(read_vault_files_impl(&vault, &[path_string(&outside.join("secret.md"))]).is_err());
        let updates = read_vault_files_impl(&vault, &[path_string(&vault.join("link.md"))]).unwrap();
        assert!(updates[0].content.is_none());
        assert_eq!(updates[0].skipped.as_deref(), Some(REASON_OUTSIDE));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn read_vault_files_reports_current_state() {
        let vault = temp_dir("batch");
        fs::write(vault.join("a.md"), "A").unwrap();
        fs::write(vault.join("b.md"), [0xFF]).unwrap();
        let paths: Vec<String> = ["a.md", "b.md", "gone.md", ".hidden/c.md"]
            .iter()
            .map(|p| path_string(&vault.join(p)))
            .collect();
        let updates = read_vault_files_impl(&vault, &paths).unwrap();
        let contents: Vec<Option<&str>> = updates.iter().map(|u| u.content.as_deref()).collect();
        assert_eq!(contents, [Some("A"), None, None, None]);
        let skipped: Vec<Option<&str>> = updates.iter().map(|u| u.skipped.as_deref()).collect();
        assert_eq!(skipped, [None, Some(REASON_NOT_UTF8), None, None]);
        assert_eq!(updates[2].rel, "gone.md");
        assert_eq!(updates[0].rel, "a.md");
        assert!(updates[0].mtime > 0.0);
        fs::remove_dir_all(&vault).unwrap();
    }

    #[test]
    fn atomic_write_keeps_creation_date() {
        let dir = temp_dir("crtime");
        let file = dir.join("a.md");
        fs::write(&file, "old").unwrap();
        let before = fs::metadata(&file).unwrap();
        std::thread::sleep(Duration::from_millis(50));
        atomic_write(&file, b"new").unwrap();
        let after = fs::metadata(&file).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "new");
        assert_ne!(after.ino(), before.ino(), "replaced by rename");
        assert_eq!(after.created().unwrap(), before.created().unwrap());
        assert!(after.modified().unwrap() > before.modified().unwrap());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn dropped_files_are_consumable_once_across_drops() {
        let dir = temp_dir("drop");
        let (a, b) = (dir.join("a.png"), dir.join("b.png"));
        fs::write(&a, "a").unwrap();
        fs::write(&b, "b").unwrap();
        let state = AppState::default();
        state.remember_dropped(std::slice::from_ref(&a));
        state.remember_dropped(std::slice::from_ref(&b));
        assert!(state.take_dropped(&a), "an earlier drop stays importable");
        assert!(state.take_dropped(&b));
        assert!(!state.take_dropped(&a), "each drop is importable once");
        assert!(!state.take_dropped(&dir.join("other.png")));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn open_refuses_launchable_files() {
        let vault = temp_dir("open");
        fs::write(vault.join("doc.pdf"), "pdf").unwrap();
        fs::write(vault.join("run.command"), "echo").unwrap();
        fs::write(vault.join("script"), "#!/bin/sh").unwrap();
        fs::set_permissions(vault.join("script"), fs::Permissions::from_mode(0o755)).unwrap();
        fs::create_dir(vault.join("Evil.app")).unwrap();
        fs::create_dir(vault.join("folder")).unwrap();

        assert!(open_target(&vault, &path_string(&vault.join("doc.pdf"))).is_ok());
        assert!(open_target(&vault, &path_string(&vault.join("folder"))).is_ok());
        for name in ["run.command", "script", "Evil.app", "missing.pdf"] {
            assert!(open_target(&vault, &path_string(&vault.join(name))).is_err(), "{name}");
        }
        fs::remove_dir_all(&vault).unwrap();
    }

    #[test]
    fn rename_keeps_inside_vault() {
        let vault = temp_dir("rename");
        let tracker = WriteTracker::default();
        let from = vault.join("a.md");
        fs::write(&from, "x").unwrap();
        assert!(rename_path_impl(&vault, &tracker, &path_string(&vault), "b").is_err());
        assert!(rename_path_impl(&vault, &tracker, &path_string(&from), "../b.md").is_err());
        let to = rename_path_impl(&vault, &tracker, &path_string(&from), "dir/b.md").unwrap();
        assert_eq!(fs::read_to_string(&to).unwrap(), "x");
        fs::remove_dir_all(&vault).unwrap();
    }
}
