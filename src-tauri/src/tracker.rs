//! Per-path write locks and hashes of the content the app itself last wrote.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use sha2::{Digest, Sha256};

pub type ContentHash = [u8; 32];

pub fn hash_bytes(bytes: &[u8]) -> ContentHash {
    let digest = Sha256::digest(bytes);
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

/// Keys are canonical paths (the form FSEvents reports).
#[derive(Default)]
pub struct WriteTracker {
    /// path → sha256 of the content most recently written by the app.
    hashes: Mutex<HashMap<PathBuf, ContentHash>>,
    /// Serializes check-and-write against other writers and the watcher's own-write check.
    locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
}

impl WriteTracker {
    pub fn lock_for(&self, path: &Path) -> Arc<Mutex<()>> {
        self.locks
            .lock()
            .entry(path.to_path_buf())
            .or_default()
            .clone()
    }

    /// Records `bytes` as the app's own content for `path`; returns the previous hash.
    pub fn record(&self, path: &Path, bytes: &[u8]) -> Option<ContentHash> {
        self.hashes
            .lock()
            .insert(path.to_path_buf(), hash_bytes(bytes))
    }

    /// Undoes `record` after a failed write.
    pub fn restore(&self, path: &Path, previous: Option<ContentHash>) {
        let mut hashes = self.hashes.lock();
        match previous {
            Some(hash) => hashes.insert(path.to_path_buf(), hash),
            None => hashes.remove(path),
        };
    }

    pub fn forget(&self, path: &Path) {
        self.hashes.lock().remove(path);
    }

    pub fn rename(&self, from: &Path, to: &Path) {
        let mut hashes = self.hashes.lock();
        if let Some(hash) = hashes.remove(from) {
            hashes.insert(to.to_path_buf(), hash);
        }
    }

    /// True when the file's current content is what the app last wrote. A stored hash
    /// that no longer matches the disk is dropped, so a later external change back to
    /// that content (A→B→A) is still reported.
    pub fn is_own_write(&self, path: &Path) -> bool {
        let lock = self.lock_for(path);
        let _guard = lock.lock();
        match fs::read(path) {
            Ok(bytes) => {
                let mut hashes = self.hashes.lock();
                match hashes.get(path) {
                    Some(stored) if *stored == hash_bytes(&bytes) => true,
                    Some(_) => {
                        hashes.remove(path);
                        false
                    }
                    None => false,
                }
            }
            Err(_) => {
                self.hashes.lock().remove(path);
                false
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_hash_is_dropped_so_a_b_a_is_reported() {
        let dir = std::env::temp_dir().join(format!("tasks-tracker-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.md");
        let tracker = WriteTracker::default();

        fs::write(&file, "A").unwrap();
        tracker.record(&file, b"A");
        assert!(tracker.is_own_write(&file));
        // Duplicate notifications for the same own write stay suppressed.
        assert!(tracker.is_own_write(&file));

        fs::write(&file, "B").unwrap();
        assert!(!tracker.is_own_write(&file));
        fs::write(&file, "A").unwrap();
        assert!(!tracker.is_own_write(&file), "external revert to A must be reported");

        fs::remove_dir_all(&dir).unwrap();
    }
}
