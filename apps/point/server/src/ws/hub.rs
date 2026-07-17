//! In-memory connection registry: user id -> live WS senders (multi-device).

use dashmap::mapref::entry::Entry;
use dashmap::DashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::Sender;
use tokio::sync::Notify;

/// Messages are pre-serialized JSON text frames.
pub type Outbound = String;

/// One live connection: its bounded outbound sender and a close signal the hub
/// can trigger to tear the socket down (revocation, D-011 parity).
struct Conn {
    id: u64,
    tx: Sender<Outbound>,
    close: Arc<Notify>,
}

#[derive(Default)]
pub struct Hub {
    conns: DashMap<String, Vec<Conn>>,
    next_id: AtomicU64,
    /// Layer-4 watcher-wake dedup: the last time a demand-wake push was sent to
    /// each watched person, so a crowd opening the same live view can't multiply
    /// pushes (max ~1 wake / window per watched-person across all watchers).
    /// Keyed by the WATCHED user's id.
    watch_wakes: DashMap<String, Instant>,
}

impl Hub {
    /// Register a connection. `close` is signalled by [`close_user`] to force
    /// this socket shut; the ws handler awaits it in its select loop.
    pub fn add_connection(&self, user_id: &str, tx: Sender<Outbound>, close: Arc<Notify>) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.conns
            .entry(user_id.to_string())
            .or_default()
            .push(Conn { id, tx, close });
        id
    }

    pub fn remove_connection(&self, user_id: &str, conn_id: u64) {
        if let Some(mut entry) = self.conns.get_mut(user_id) {
            entry.retain(|c| c.id != conn_id);
            let empty = entry.is_empty();
            drop(entry);
            if empty {
                self.conns.remove_if(user_id, |_, v| v.is_empty());
            }
        }
    }

    /// Send to every live connection of a user (multi-device). The outbound
    /// channel is bounded: if a connection's buffer is full (a slow/dead
    /// reader), that delivery is dropped rather than blocking the sender —
    /// the heartbeat will eventually disconnect a truly stuck reader.
    pub fn send_to_user(&self, user_id: &str, msg: &str) {
        if let Some(entry) = self.conns.get(user_id) {
            for conn in entry.iter() {
                if let Err(e) = conn.tx.try_send(msg.to_string()) {
                    tracing::debug!(user_id, error = %e, "dropped outbound frame (channel full/closed)");
                }
            }
        }
    }

    pub fn send_to_users<'a>(&self, user_ids: impl IntoIterator<Item = &'a String>, msg: &str) {
        for uid in user_ids {
            self.send_to_user(uid, msg);
        }
    }

    /// Force every live connection of `user_id` to close (revocation): password
    /// change and account deletion call this so an already-open socket holding
    /// a now-dead token is torn down, not just blocked at the next connect
    /// (M11 / D-011 parity). Each connection's select loop wakes on its
    /// `close` Notify, breaks, and unregisters (emitting offline presence).
    pub fn close_user(&self, user_id: &str) {
        if let Some(entry) = self.conns.get(user_id) {
            for conn in entry.iter() {
                // notify_one leaves a permit if the loop isn't parked yet, so a
                // close racing registration is never lost.
                conn.close.notify_one();
            }
        }
    }

    /// Layer-4 watcher-wake dedup gate. Returns `true` (and records "now") at
    /// most once per `window` per watched `target`, across all watchers — so a
    /// crowd opening one person's live view yields a single demand-wake push,
    /// not one per viewer. The check-and-set is atomic (the DashMap entry holds
    /// its shard lock across it), so two simultaneous watchers can't both pass.
    pub fn note_watch_wake(&self, target: &str, window: Duration) -> bool {
        let now = Instant::now();
        match self.watch_wakes.entry(target.to_string()) {
            Entry::Occupied(mut e) => {
                if now.saturating_duration_since(*e.get()) >= window {
                    *e.get_mut() = now;
                    true
                } else {
                    false
                }
            }
            Entry::Vacant(e) => {
                e.insert(now);
                true
            }
        }
    }

    /// The last recorded watcher-wake for `target`, if any. Read-only: lets a
    /// test observe the dedup gate without mutating it (test-only).
    #[cfg(test)]
    pub fn last_watch_wake(&self, target: &str) -> Option<Instant> {
        self.watch_wakes.get(target).map(|r| *r)
    }

    pub fn is_online(&self, user_id: &str) -> bool {
        self.conns
            .get(user_id)
            .map(|v| !v.is_empty())
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watch_wake_dedup_allows_first_denies_within_window() {
        let hub = Hub::default();
        let window = Duration::from_secs(15);
        // First wake for a target passes.
        assert!(hub.note_watch_wake("bob", window));
        // Subsequent wakes inside the window are deduped — one serves all.
        assert!(!hub.note_watch_wake("bob", window));
        assert!(!hub.note_watch_wake("bob", window));
        // A different watched person is independent.
        assert!(hub.note_watch_wake("carol", window));
    }

    #[test]
    fn watch_wake_allows_again_once_window_elapses() {
        let hub = Hub::default();
        // A zero-length window means every call is outside it: never deduped.
        assert!(hub.note_watch_wake("bob", Duration::ZERO));
        assert!(hub.note_watch_wake("bob", Duration::ZERO));
    }

    #[test]
    fn last_watch_wake_observes_without_mutating() {
        let hub = Hub::default();
        assert!(hub.last_watch_wake("bob").is_none());
        assert!(hub.note_watch_wake("bob", Duration::from_secs(15)));
        let t = hub.last_watch_wake("bob").expect("recorded");
        // Reading doesn't reset the gate: still deduped, timestamp unchanged.
        assert!(!hub.note_watch_wake("bob", Duration::from_secs(15)));
        assert_eq!(hub.last_watch_wake("bob"), Some(t));
    }
}
