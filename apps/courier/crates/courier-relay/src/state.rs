//! Persisted per-room "last seen" high-water marks (atomic writes).
//!
//! File names and layout are compatible with the previous generation
//! (`relay-last-seen.json` / `relay-delivery.json` in the store directory),
//! so pointing the new bot at existing data adopts the old state.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};
use tracing::warn;

/// Per-room last-seen timestamps plus their backing file.
#[derive(Debug)]
pub struct LastSeen {
    path: PathBuf,
    rooms: HashMap<String, u64>,
}

impl LastSeen {
    /// Load from `path`; corrupt or missing files start fresh.
    pub fn load(path: PathBuf) -> Self {
        let rooms = match std::fs::read_to_string(&path) {
            Ok(data) => match serde_json::from_str(&data) {
                Ok(map) => map,
                Err(e) => {
                    warn!(path = %path.display(), error = %e, "Relay last-seen state is corrupt; starting fresh");
                    HashMap::new()
                }
            },
            Err(e) => {
                if path.exists() {
                    warn!(path = %path.display(), error = %e, "Failed to read relay last-seen state; starting fresh");
                }
                HashMap::new()
            }
        };
        Self { path, rooms }
    }

    pub fn get(&self, room_id: &str) -> Option<u64> {
        self.rooms.get(room_id).copied()
    }

    /// Advance the mark for `room_id` to `ts` if newer, persisting on change.
    pub fn advance(&mut self, room_id: &str, ts: u64) {
        let entry = self.rooms.entry(room_id.to_owned()).or_default();
        if ts <= *entry {
            return;
        }
        *entry = ts;
        if let Err(e) = write_file(&self.path, &self.rooms) {
            warn!(path = %self.path.display(), error = %e, "Failed to write relay last-seen state");
        }
    }
}

fn write_file(path: &Path, rooms: &HashMap<String, u64>) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating relay state directory {}", parent.display()))?;
    }
    let data = serde_json::to_string_pretty(rooms).context("serializing relay last-seen state")?;
    // Atomic write: this file is rewritten on every relayed message, so a
    // crash mid-write must not leave corrupt JSON that resets the marker on
    // next boot.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, data).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, path)
        .with_context(|| format!("renaming {} -> {}", tmp.display(), path.display()))?;
    Ok(())
}

/// `relay-last-seen.json` lives next to the history directory (i.e. in the
/// store directory), matching the previous generation's layout.
pub fn last_seen_path(history_dir: &Path) -> PathBuf {
    history_dir.parent().map_or_else(
        || PathBuf::from("./data/relay-last-seen.json"),
        |parent| parent.join("relay-last-seen.json"),
    )
}

/// `relay-delivery.json` (the delivery ledger), same placement rule.
pub fn delivery_ledger_path(history_dir: &Path) -> PathBuf {
    history_dir.parent().map_or_else(
        || PathBuf::from("./data/relay-delivery.json"),
        |parent| parent.join("relay-delivery.json"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_seen_only_advances_forward_and_persists() {
        let path = std::env::temp_dir().join(format!(
            "courier-last-seen-test-{}.json",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        {
            let mut state = LastSeen::load(path.clone());
            state.advance("!a:hs", 100);
            state.advance("!a:hs", 50); // must not regress
            assert_eq!(state.get("!a:hs"), Some(100));
        }
        let reloaded = LastSeen::load(path.clone());
        assert_eq!(reloaded.get("!a:hs"), Some(100));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn state_paths_sit_next_to_history_dir() {
        let history = PathBuf::from("/data/store/history");
        assert_eq!(
            last_seen_path(&history),
            PathBuf::from("/data/store/relay-last-seen.json")
        );
        assert_eq!(
            delivery_ledger_path(&history),
            PathBuf::from("/data/store/relay-delivery.json")
        );
    }
}
