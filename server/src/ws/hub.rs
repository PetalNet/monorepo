//! In-memory connection registry: user id -> live WS senders (multi-device).

use dashmap::DashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::mpsc::UnboundedSender;

/// Messages are pre-serialized JSON text frames.
pub type Outbound = String;

#[derive(Default)]
pub struct Hub {
    conns: DashMap<String, Vec<(u64, UnboundedSender<Outbound>)>>,
    next_id: AtomicU64,
}

impl Hub {
    pub fn add_connection(&self, user_id: &str, tx: UnboundedSender<Outbound>) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.conns
            .entry(user_id.to_string())
            .or_default()
            .push((id, tx));
        id
    }

    pub fn remove_connection(&self, user_id: &str, conn_id: u64) {
        if let Some(mut entry) = self.conns.get_mut(user_id) {
            entry.retain(|(id, _)| *id != conn_id);
            let empty = entry.is_empty();
            drop(entry);
            if empty {
                self.conns.remove_if(user_id, |_, v| v.is_empty());
            }
        }
    }

    /// Send to every live connection of a user (multi-device). Dead senders are
    /// pruned lazily on the next remove.
    pub fn send_to_user(&self, user_id: &str, msg: &str) {
        if let Some(entry) = self.conns.get(user_id) {
            for (_, tx) in entry.iter() {
                let _ = tx.send(msg.to_string());
            }
        }
    }

    pub fn send_to_users<'a>(&self, user_ids: impl IntoIterator<Item = &'a String>, msg: &str) {
        for uid in user_ids {
            self.send_to_user(uid, msg);
        }
    }

    pub fn is_online(&self, user_id: &str) -> bool {
        self.conns
            .get(user_id)
            .map(|v| !v.is_empty())
            .unwrap_or(false)
    }
}
