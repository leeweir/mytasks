//! Recursive FSEvents watcher for the vault, debounced, emitting `vault-changed`.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use notify::event::{CreateKind, ModifyKind, RemoveKind};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::tracker::WriteTracker;
use crate::vault::{is_excluded_rel, is_markdown};

/// Quiet period after the last event before a batch is flushed.
const DEBOUNCE: Duration = Duration::from_millis(150);
/// Upper bound on how long a continuous stream of events can delay a flush.
const MAX_DELAY: Duration = Duration::from_secs(1);

/// Payload of the `vault-changed` event.
#[derive(Serialize, Clone)]
struct VaultChanged {
    /// Canonical absolute paths of Markdown files changed by other programs.
    paths: Vec<String>,
    /// Something changed that cannot be mapped to individual files: reload everything.
    full: bool,
}

#[derive(Debug, PartialEq)]
enum Change {
    File(PathBuf),
    Full,
}

/// Owns the OS watcher; dropping it stops watching and ends the debounce thread.
pub struct VaultWatcher {
    _watcher: RecommendedWatcher,
    /// Cleared on drop so a batch already in flight for this vault is not emitted.
    active: Arc<AtomicBool>,
}

impl Drop for VaultWatcher {
    fn drop(&mut self) {
        self.active.store(false, Ordering::SeqCst);
    }
}

impl VaultWatcher {
    pub fn start(app: AppHandle, vault: PathBuf, tracker: Arc<WriteTracker>) -> Result<Self, String> {
        let (tx, rx) = mpsc::channel::<Change>();
        let filter_root = vault.clone();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            let event = match res {
                Ok(event) => event,
                Err(e) => {
                    eprintln!("tasks: watcher error: {e}");
                    // Events may have been lost.
                    let _ = tx.send(Change::Full);
                    return;
                }
            };
            for change in classify(&filter_root, &event) {
                // Receiver gone means the watcher is being torn down.
                let _ = tx.send(change);
            }
        })
        .map_err(|e| format!("cannot create watcher: {e}"))?;
        watcher
            .watch(&vault, RecursiveMode::Recursive)
            .map_err(|e| format!("cannot watch {}: {e}", vault.display()))?;

        let active = Arc::new(AtomicBool::new(true));
        let thread_active = active.clone();
        std::thread::Builder::new()
            .name("vault-watcher".into())
            .spawn(move || debounce_loop(rx, app, tracker, thread_active))
            .map_err(|e| format!("cannot start watcher thread: {e}"))?;

        Ok(Self {
            _watcher: watcher,
            active,
        })
    }
}

/// Maps one notification to Markdown file changes, or to a full reload when it concerns
/// a directory (rename, move, trash), dropped events, or anything else that cannot be
/// attributed to individual Markdown files.
fn classify(vault: &Path, event: &Event) -> Vec<Change> {
    if event.need_rescan() {
        return vec![Change::Full];
    }
    if matches!(event.kind, EventKind::Access(_)) {
        return Vec::new();
    }
    event
        .paths
        .iter()
        .filter_map(|path| classify_path(vault, &event.kind, path))
        .collect()
}

fn classify_path(vault: &Path, kind: &EventKind, path: &Path) -> Option<Change> {
    let rel = path.strip_prefix(vault).ok()?;
    if is_excluded_rel(rel) {
        return None;
    }
    if matches!(
        kind,
        EventKind::Create(CreateKind::Folder) | EventKind::Remove(RemoveKind::Folder)
    ) {
        return Some(Change::Full);
    }
    let is_dir = || fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false);
    if is_markdown(path) && !is_dir() {
        return Some(Change::File(path.to_path_buf()));
    }
    // Content or metadata changes of a non-Markdown item never change the listing.
    if matches!(
        kind,
        EventKind::Modify(ModifyKind::Data(_) | ModifyKind::Metadata(_))
            | EventKind::Create(CreateKind::File)
            | EventKind::Remove(RemoveKind::File)
    ) {
        return None;
    }
    match fs::symlink_metadata(path) {
        Ok(meta) if !meta.is_dir() => None,
        // A directory, or something gone that may have been a directory (moved away).
        _ => Some(Change::Full),
    }
}

fn debounce_loop(
    rx: mpsc::Receiver<Change>,
    app: AppHandle,
    tracker: Arc<WriteTracker>,
    active: Arc<AtomicBool>,
) {
    while let Ok(first) = rx.recv() {
        let mut batch = BTreeSet::new();
        let mut full = false;
        let mut add = |change: Change| match change {
            Change::File(path) => {
                batch.insert(path);
            }
            Change::Full => full = true,
        };
        add(first);
        let started = Instant::now();
        let mut disconnected = false;
        while started.elapsed() < MAX_DELAY {
            match rx.recv_timeout(DEBOUNCE) {
                Ok(change) => add(change),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    disconnected = true;
                    break;
                }
            }
        }
        if disconnected || !active.load(Ordering::SeqCst) {
            // The vault was switched or closed; changes to the old vault are irrelevant.
            return;
        }
        flush(&app, &tracker, batch, full);
    }
}

fn flush(app: &AppHandle, tracker: &WriteTracker, batch: BTreeSet<PathBuf>, full: bool) {
    let paths: Vec<String> = batch
        .into_iter()
        .filter(|path| !tracker.is_own_write(path))
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    if paths.is_empty() && !full {
        return;
    }
    if let Err(e) = app.emit("vault-changed", VaultChanged { paths, full }) {
        eprintln!("tasks: cannot emit vault-changed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{Flag, RenameMode};

    #[test]
    fn classifies_directory_and_rescan_events_as_full() {
        let vault = std::env::temp_dir().join(format!("tasks-classify-{}", std::process::id()));
        fs::create_dir_all(vault.join("folder")).unwrap();
        fs::write(vault.join("image.png"), "png").unwrap();
        let vault = fs::canonicalize(&vault).unwrap();
        let event = |kind: EventKind, rel: &str| Event::new(kind).add_path(vault.join(rel));
        let rename = EventKind::Modify(ModifyKind::Name(RenameMode::Any));

        assert_eq!(
            classify(&vault, &event(EventKind::Modify(ModifyKind::Any), "a.md")),
            [Change::File(vault.join("a.md"))]
        );
        // A folder renamed in Finder: old name gone, new name a directory.
        assert_eq!(classify(&vault, &event(rename, "old-folder")), [Change::Full]);
        assert_eq!(classify(&vault, &event(rename, "folder")), [Change::Full]);
        assert_eq!(
            classify(&vault, &event(EventKind::Remove(RemoveKind::Folder), "gone")),
            [Change::Full]
        );
        assert_eq!(
            classify(&vault, &Event::new(EventKind::Other).set_flag(Flag::Rescan)),
            [Change::Full]
        );
        // Irrelevant: existing non-Markdown files, hidden paths, temp files, outside the vault.
        assert!(classify(&vault, &event(rename, "image.png")).is_empty());
        assert!(classify(&vault, &event(EventKind::Create(CreateKind::File), "x.png")).is_empty());
        assert!(classify(&vault, &event(rename, ".obsidian/x")).is_empty());
        assert!(classify(&vault, &event(rename, ".a.md.1-2.tmp")).is_empty());
        assert!(classify(&vault, &Event::new(rename).add_path("/elsewhere/a.md".into())).is_empty());
        fs::remove_dir_all(&vault).unwrap();
    }
}
