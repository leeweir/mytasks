//! Recursive FSEvents watcher for the vault, debounced, emitting `vault-changed`.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use crate::vault::{hash_bytes, is_excluded_rel, is_markdown, WrittenHashes};

/// Quiet period after the last event before a batch is flushed.
const DEBOUNCE: Duration = Duration::from_millis(150);
/// Upper bound on how long a continuous stream of events can delay a flush.
const MAX_DELAY: Duration = Duration::from_secs(1);

/// Owns the OS watcher; dropping it stops watching and ends the debounce thread.
pub struct VaultWatcher {
    _watcher: RecommendedWatcher,
}

impl VaultWatcher {
    pub fn start(app: AppHandle, vault: PathBuf, written: WrittenHashes) -> Result<Self, String> {
        let (tx, rx) = mpsc::channel::<PathBuf>();
        let filter_root = vault.clone();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let event = match res {
                Ok(event) => event,
                Err(e) => {
                    eprintln!("tasks: watcher error: {e}");
                    return;
                }
            };
            if matches!(event.kind, EventKind::Access(_)) {
                return;
            }
            for path in event.paths {
                if is_relevant(&filter_root, &path) {
                    // Receiver gone means the watcher is being torn down.
                    let _ = tx.send(path);
                }
            }
        })
        .map_err(|e| format!("cannot create watcher: {e}"))?;
        watcher
            .watch(&vault, RecursiveMode::Recursive)
            .map_err(|e| format!("cannot watch {}: {e}", vault.display()))?;

        std::thread::Builder::new()
            .name("vault-watcher".into())
            .spawn(move || debounce_loop(rx, app, written))
            .map_err(|e| format!("cannot start watcher thread: {e}"))?;

        Ok(Self { _watcher: watcher })
    }
}

fn is_relevant(vault: &Path, path: &Path) -> bool {
    is_markdown(path)
        && path
            .strip_prefix(vault)
            .map(|rel| !is_excluded_rel(rel))
            .unwrap_or(false)
}

fn debounce_loop(rx: mpsc::Receiver<PathBuf>, app: AppHandle, written: WrittenHashes) {
    while let Ok(first) = rx.recv() {
        let mut batch = BTreeSet::from([first]);
        let started = Instant::now();
        let mut disconnected = false;
        while started.elapsed() < MAX_DELAY {
            match rx.recv_timeout(DEBOUNCE) {
                Ok(path) => {
                    batch.insert(path);
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    disconnected = true;
                    break;
                }
            }
        }
        if disconnected {
            // The vault was switched or closed; changes to the old vault are irrelevant.
            return;
        }
        flush(&app, &written, batch);
    }
}

fn flush(app: &AppHandle, written: &WrittenHashes, batch: BTreeSet<PathBuf>) {
    let paths: Vec<String> = batch
        .into_iter()
        .filter(|path| !is_own_write(written, path))
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    if paths.is_empty() {
        return;
    }
    if let Err(e) = app.emit("vault-changed", &paths) {
        eprintln!("tasks: cannot emit vault-changed: {e}");
    }
}

/// True when the file's current content matches the last content written by the app.
fn is_own_write(written: &WrittenHashes, path: &Path) -> bool {
    match fs::read(path) {
        Ok(bytes) => written.lock().get(path) == Some(&hash_bytes(&bytes)),
        Err(_) => {
            written.lock().remove(path);
            false
        }
    }
}
