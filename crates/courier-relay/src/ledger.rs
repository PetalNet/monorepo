//! Per-(source event, target room) delivery ledger — the idempotency core.
//!
//! A per-room "last seen timestamp" high-water mark alone loses messages two
//! ways:
//!
//! 1. Partial fan-out: one leg succeeds, another fails → the mark advances
//!    and the failed leg is never retried by backfill.
//! 2. Concurrent relays: a newer event completing first advances the mark
//!    past an older event still in flight; if the older one then fails,
//!    backfill skips it.
//!
//! This ledger records exactly which targets each source event reached. The
//! high-water mark only advances on FULL delivery, incomplete events are
//! retried by backfill regardless of the mark, and already-delivered legs
//! are skipped on retry so the successful side never sees duplicates.
//! Persisted as JSON (atomic writes) next to the last-seen file so
//! crash-interrupted deliveries are retried after restart.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};
use tracing::warn;

/// Cap on tracked events. Complete entries are pruned first (oldest first),
/// then — only if still over — the oldest incomplete entries, loudly.
const LEDGER_CAP: usize = 2000;

/// Delivery state for one source event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveryRecord {
    /// Source room the event arrived in.
    pub room: String,
    /// `origin_server_ts` (ms) of the source event.
    pub ts: u64,
    /// Target rooms that have confirmed delivery.
    #[serde(default)]
    pub delivered: BTreeSet<String>,
    /// True once every required target confirmed.
    #[serde(default)]
    pub complete: bool,
}

/// Persistent map of source event id → [`DeliveryRecord`].
#[derive(Debug)]
pub struct DeliveryLedger {
    path: PathBuf,
    events: HashMap<String, DeliveryRecord>,
}

impl DeliveryLedger {
    /// Load the ledger from `path`; corrupt or missing files start fresh
    /// (backfill then falls back to the last-seen mark, worst case a few
    /// duplicate-suppressed resends thanks to stable transaction ids).
    pub(crate) fn load(path: PathBuf) -> Self {
        let events = match std::fs::read_to_string(&path) {
            Ok(data) => match serde_json::from_str(&data) {
                Ok(map) => map,
                Err(e) => {
                    warn!(path = %path.display(), error = %e, "Relay delivery ledger is corrupt; starting fresh");
                    HashMap::new()
                }
            },
            Err(e) => {
                if path.exists() {
                    warn!(path = %path.display(), error = %e, "Failed to read relay delivery ledger; starting fresh");
                }
                HashMap::new()
            }
        };
        Self { path, events }
    }

    pub(crate) fn get(&self, event_id: &str) -> Option<&DeliveryRecord> {
        self.events.get(event_id)
    }

    /// Ensure an (incomplete) record exists for this event before any send
    /// is attempted, so a crash mid-fan-out leaves a retryable trace on disk.
    pub(crate) fn record_attempt(&mut self, event_id: &str, room: &str, ts: u64) {
        if self.events.contains_key(event_id) {
            return;
        }
        self.events.insert(
            event_id.to_owned(),
            DeliveryRecord {
                room: room.to_owned(),
                ts,
                delivered: BTreeSet::new(),
                complete: false,
            },
        );
        self.prune();
        self.persist();
    }

    /// Record that `target` confirmed delivery of `event_id`.
    pub(crate) fn record_delivery(&mut self, event_id: &str, target: &str) {
        if let Some(record) = self.events.get_mut(event_id) {
            if record.delivered.insert(target.to_owned()) {
                self.persist();
            }
        } else {
            warn!(
                event_id,
                target, "Delivery recorded for unknown ledger entry"
            );
        }
    }

    /// Mark `event_id` as fully delivered to every required target.
    pub(crate) fn set_complete(&mut self, event_id: &str) {
        if let Some(record) = self.events.get_mut(event_id)
            && !record.complete
        {
            record.complete = true;
            self.persist();
        }
    }

    fn prune(&mut self) {
        if self.events.len() <= LEDGER_CAP {
            return;
        }
        let excess = self.events.len() - LEDGER_CAP;
        // Oldest complete entries first; they are only kept to suppress
        // backfill duplicates and lose nothing when dropped.
        let mut complete: Vec<(String, u64)> = self
            .events
            .iter()
            .filter(|(_, r)| r.complete)
            .map(|(id, r)| (id.clone(), r.ts))
            .collect();
        complete.sort_by_key(|(_, ts)| *ts);
        for (id, _) in complete.into_iter().take(excess) {
            self.events.remove(&id);
        }
        if self.events.len() > LEDGER_CAP {
            let over = self.events.len() - LEDGER_CAP;
            warn!(
                over,
                cap = LEDGER_CAP,
                "Delivery ledger over cap with incomplete entries; dropping oldest (their retries are lost)"
            );
            let mut incomplete: Vec<(String, u64)> = self
                .events
                .iter()
                .map(|(id, r)| (id.clone(), r.ts))
                .collect();
            incomplete.sort_by_key(|(_, ts)| *ts);
            for (id, _) in incomplete.into_iter().take(over) {
                self.events.remove(&id);
            }
        }
    }

    fn persist(&self) {
        if let Err(e) = write_ledger_file(&self.path, &self.events) {
            warn!(path = %self.path.display(), error = %e, "Failed to write relay delivery ledger");
        }
    }
}

fn write_ledger_file(path: &Path, events: &HashMap<String, DeliveryRecord>) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating ledger directory {}", parent.display()))?;
    }
    let data = serde_json::to_string(events).context("serializing relay delivery ledger")?;
    // Atomic write: a crash mid-write must not corrupt the ledger.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, data).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, path)
        .with_context(|| format!("renaming {} -> {}", tmp.display(), path.display()))?;
    Ok(())
}

/// Pure backfill decision for one candidate event.
///
/// - complete in the ledger → never resend;
/// - incomplete in the ledger → retry its missing legs, REGARDLESS of the
///   last-seen mark (a newer event may have advanced it past this one);
/// - unknown to the ledger → relay when newer than the last-seen mark.
#[must_use]
pub fn should_backfill(ts: u64, marker: Option<u64>, record: Option<&DeliveryRecord>) -> bool {
    record.map_or_else(|| marker.is_none_or(|m| ts > m), |rec| !rec.complete)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_ledger_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "courier-ledger-test-{}-{tag}.json",
            std::process::id()
        ))
    }

    #[test]
    fn partial_fanout_is_not_complete_and_is_backfilled() {
        let path = temp_ledger_path("partial");
        let _ = std::fs::remove_file(&path);
        let mut ledger = DeliveryLedger::load(path.clone());

        ledger.record_attempt("$ev1", "!src:hs", 100);
        ledger.record_delivery("$ev1", "!target-a:hs");
        // Second leg failed → never marked complete.

        let rec = ledger.get("$ev1").expect("record exists");
        assert!(!rec.complete, "partial fan-out must not be complete");
        assert!(rec.delivered.contains("!target-a:hs"));

        // Even when the high-water mark has advanced PAST this event
        // (a newer event fully delivered), the incomplete event is retried.
        assert!(
            should_backfill(100, Some(200), ledger.get("$ev1")),
            "incomplete event must be retried regardless of the last-seen mark"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn complete_events_are_never_resent() {
        let path = temp_ledger_path("complete");
        let _ = std::fs::remove_file(&path);
        let mut ledger = DeliveryLedger::load(path.clone());

        ledger.record_attempt("$ev2", "!src:hs", 100);
        ledger.record_delivery("$ev2", "!target-a:hs");
        ledger.set_complete("$ev2");

        // Complete beats even a stale marker (a marker held back by an older
        // incomplete event must not cause duplicates of this one).
        assert!(
            !should_backfill(100, Some(50), ledger.get("$ev2")),
            "complete event must not be resent even when newer than the mark"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn unknown_events_respect_the_marker() {
        assert!(should_backfill(100, None, None), "no marker → relay");
        assert!(should_backfill(100, Some(50), None), "newer than marker");
        assert!(!should_backfill(100, Some(100), None), "not newer");
        assert!(!should_backfill(100, Some(150), None), "older than marker");
    }

    #[test]
    fn ledger_survives_restart() {
        let path = temp_ledger_path("persist");
        let _ = std::fs::remove_file(&path);
        {
            let mut ledger = DeliveryLedger::load(path.clone());
            ledger.record_attempt("$ev3", "!src:hs", 42);
            ledger.record_delivery("$ev3", "!target-a:hs");
        }
        // Simulated crash before completion: reload from disk.
        let reloaded = DeliveryLedger::load(path.clone());
        let rec = reloaded.get("$ev3").expect("record persisted");
        assert_eq!(rec.ts, 42);
        assert!(rec.delivered.contains("!target-a:hs"));
        assert!(!rec.complete, "incomplete state must survive a restart");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn prune_drops_complete_entries_first() {
        let path = temp_ledger_path("prune");
        let _ = std::fs::remove_file(&path);
        let mut ledger = DeliveryLedger::load(path.clone());
        for i in 0..LEDGER_CAP {
            let id = format!("$old{i}");
            ledger.events.insert(
                id,
                DeliveryRecord {
                    room: "!src:hs".to_owned(),
                    ts: u64::try_from(i).expect("small"),
                    delivered: BTreeSet::new(),
                    complete: true,
                },
            );
        }
        // One incomplete entry, older than everything else.
        ledger.events.insert(
            "$incomplete".to_owned(),
            DeliveryRecord {
                room: "!src:hs".to_owned(),
                ts: 0,
                delivered: BTreeSet::new(),
                complete: false,
            },
        );
        ledger.record_attempt("$new", "!src:hs", 999_999);
        assert!(ledger.events.len() <= LEDGER_CAP);
        assert!(
            ledger.get("$incomplete").is_some(),
            "incomplete entries are kept over complete ones"
        );
        assert!(ledger.get("$new").is_some());

        let _ = std::fs::remove_file(&path);
    }
}
