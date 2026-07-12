//! Inbound envelope dedup + the DURABLE pending-work queue (BA3, codex review).
//!
//! Two durable facts live here in the box-agent's own SQLite:
//!
//! - `seen` — envelope ids already handled (contract D20: redials re-send the
//!   same id; receivers MUST de-duplicate). Non-work envelopes dedup here.
//!   Recorded only AFTER the envelope is fully handled, so a crash mid-handle
//!   leaves the spool line for reprocessing.
//! - `pending` — the SOURCE OF TRUTH for accepted-but-unfinished task cards.
//!   A card is written here (idempotent on card_id) the moment it's accepted;
//!   the worker pool is driven FROM this table, and a row is deleted only when
//!   its worker finishes and the response is emitted. A restart reloads
//!   pending → no queued or in-flight card is ever lost, and a failed spawn
//!   just leaves the row for the next tick.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use dispatcher::card::TaskCard;

pub struct Inbox {
    conn: Connection,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Accept {
    /// First sight of this id — process it.
    Fresh,
    /// Already recorded — acknowledge but do not re-run.
    Duplicate,
}

/// A durable pending-work row: an accepted card awaiting or holding a worker.
pub struct PendingCard {
    pub card: TaskCard,
    pub request_id: String,
}

impl Inbox {
    pub fn open(path: &Path) -> Result<Inbox, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_millis(5000))
            .map_err(|e| e.to_string())?;
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS seen (
                id   TEXT PRIMARY KEY,
                seen_at_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS pending (
                card_id    TEXT PRIMARY KEY,
                request_id TEXT NOT NULL,
                card_json  TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL
            );",
        )
        .map_err(|e| e.to_string())?;
        Ok(Inbox { conn })
    }

    /// Mark a non-work envelope id handled. INSERT OR IGNORE makes the
    /// check-and-mark atomic.
    pub fn mark_envelope(&self, id: &str, now_ms: i64) -> Result<Accept, String> {
        let n = self
            .conn
            .execute(
                "INSERT OR IGNORE INTO seen (id, seen_at_ms) VALUES (?1, ?2)",
                params![id, now_ms],
            )
            .map_err(|e| e.to_string())?;
        Ok(if n == 1 {
            Accept::Fresh
        } else {
            Accept::Duplicate
        })
    }

    pub fn is_envelope_seen(&self, id: &str) -> Result<bool, String> {
        self.conn
            .query_row("SELECT 1 FROM seen WHERE id=?1", params![id], |_| Ok(()))
            .optional()
            .map(|o| o.is_some())
            .map_err(|e| e.to_string())
    }

    /// Durably accept a task card into the pending queue. Idempotent on
    /// card_id: a replayed card (new envelope id, same card) is a no-op and
    /// returns Duplicate — this IS the card-level dedup, and because the row
    /// is the durable work record, it can never be "deduped away" before the
    /// work runs.
    pub fn enqueue_card(
        &self,
        card: &TaskCard,
        request_id: &str,
        now_ms: i64,
    ) -> Result<Accept, String> {
        let card_json = serde_json::to_string(card).map_err(|e| e.to_string())?;
        let n = self
            .conn
            .execute(
                "INSERT OR IGNORE INTO pending (card_id, request_id, card_json, created_at_ms)
                 VALUES (?1, ?2, ?3, ?4)",
                params![card.card_id, request_id, card_json, now_ms],
            )
            .map_err(|e| e.to_string())?;
        Ok(if n == 1 {
            Accept::Fresh
        } else {
            Accept::Duplicate
        })
    }

    /// All pending cards, oldest first (FIFO) — the work the pool draws from.
    pub fn load_pending(&self) -> Result<Vec<PendingCard>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT request_id, card_json FROM pending ORDER BY created_at_ms ASC, rowid ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let request_id: String = row.get(0)?;
                let card_json: String = row.get(1)?;
                Ok((request_id, card_json))
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            let (request_id, card_json) = row.map_err(|e| e.to_string())?;
            match serde_json::from_str::<TaskCard>(&card_json) {
                Ok(card) => out.push(PendingCard { card, request_id }),
                Err(e) => eprintln!("box-agent: dropping unparsable pending row: {e}"),
            }
        }
        Ok(out)
    }

    /// Remove a pending card — called only after its worker finished and the
    /// response was emitted.
    pub fn complete_card(&self, card_id: &str) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM pending WHERE card_id=?1", params![card_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn pending_count(&self) -> Result<usize, String> {
        self.conn
            .query_row("SELECT COUNT(*) FROM pending", [], |r| r.get::<_, i64>(0))
            .map(|n| n as usize)
            .map_err(|e| e.to_string())
    }

    /// Drop `seen` rows older than `keep_ms` so the dedup table doesn't grow
    /// forever on a years-running agent (adversarial-review #11). The
    /// retention must exceed the dispatcher's max redelivery horizon; pending
    /// rows are never pruned (they're the work itself).
    pub fn prune_seen(&self, older_than_ms: i64) -> Result<usize, String> {
        self.conn
            .execute(
                "DELETE FROM seen WHERE seen_at_ms < ?1",
                params![older_than_ms],
            )
            .map_err(|e| e.to_string())
    }
}

/// Rename the box-agent's spool (`<inbox_dir>/<handle>.outbox.jsonl`) to a
/// `.working` file and return its lines. The `.working` file is LEFT in place;
/// the caller deletes it via [`commit_spool`] only after every line is durably
/// handled (recorded in `seen` or `pending`). A crash before commit leaves the
/// `.working` file, which the next `take_spool` reclaims — at-least-once with
/// no loss (codex review). Also reclaims a `.working` left by a prior crash.
pub fn take_spool(inbox_dir: &Path, handle: &str) -> Result<Vec<String>, String> {
    let working = inbox_dir.join(format!("{handle}.outbox.working"));
    let jsonl = inbox_dir.join(format!("{handle}.outbox.jsonl"));
    // If a prior .working exists (crash before commit), fold it back in first.
    if working.exists() && jsonl.exists() {
        // Both present: append the fresh jsonl onto the recovered working, then
        // treat working as the batch. Simplicity over perfect ordering — dedup
        // makes re-processing safe.
        if let Ok(fresh) = std::fs::read_to_string(&jsonl) {
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new().append(true).open(&working) {
                let _ = f.write_all(fresh.as_bytes());
            }
            let _ = std::fs::remove_file(&jsonl);
        }
    } else if jsonl.exists() && std::fs::rename(&jsonl, &working).is_err() {
        return Ok(Vec::new());
    }
    if !working.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(&working).map_err(|e| e.to_string())?;
    Ok(content.lines().map(str::to_string).collect())
}

/// Delete the `.working` batch after every line was durably handled.
pub fn commit_spool(inbox_dir: &Path, handle: &str) {
    let working = inbox_dir.join(format!("{handle}.outbox.working"));
    let _ = std::fs::remove_file(working);
}

#[cfg(test)]
mod tests {
    use super::*;
    use dispatcher::card::{InterruptPolicy, SenderClass};

    fn card(id: &str) -> TaskCard {
        TaskCard {
            schema_version: 1,
            card_id: id.into(),
            task_id: 7,
            sender: "dispatcher".into(),
            sender_class: SenderClass::System,
            recipient: "box-a".into(),
            priority: 2,
            thread: None,
            requires_reply: false,
            interrupt_policy: InterruptPolicy::Defer,
            body: "b".into(),
            capability: None,
            lease: None,
            created_at: "2026-07-12T11:00:00Z".into(),
            expires_at: None,
        }
    }

    #[test]
    fn envelope_dedup_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("inbox.db");
        {
            let inbox = Inbox::open(&db).unwrap();
            assert_eq!(inbox.mark_envelope("e1", 0).unwrap(), Accept::Fresh);
            assert_eq!(inbox.mark_envelope("e1", 1).unwrap(), Accept::Duplicate);
        }
        let inbox = Inbox::open(&db).unwrap();
        assert_eq!(inbox.mark_envelope("e1", 2).unwrap(), Accept::Duplicate);
        assert_eq!(inbox.mark_envelope("e2", 3).unwrap(), Accept::Fresh);
    }

    #[test]
    fn pending_queue_is_durable_and_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("inbox.db");
        {
            let inbox = Inbox::open(&db).unwrap();
            assert_eq!(
                inbox.enqueue_card(&card("c1"), "r1", 0).unwrap(),
                Accept::Fresh
            );
            // Replay under a new envelope id: same card → no duplicate row.
            assert_eq!(
                inbox.enqueue_card(&card("c1"), "r2", 1).unwrap(),
                Accept::Duplicate
            );
            assert_eq!(
                inbox.enqueue_card(&card("c2"), "r3", 2).unwrap(),
                Accept::Fresh
            );
        }
        // Restart: pending work is still here (nothing lost).
        let inbox = Inbox::open(&db).unwrap();
        assert_eq!(inbox.pending_count().unwrap(), 2);
        let pending = inbox.load_pending().unwrap();
        assert_eq!(pending[0].card.card_id, "c1");
        assert_eq!(
            pending[0].request_id, "r1",
            "first request_id wins (idempotent)"
        );
        inbox.complete_card("c1").unwrap();
        assert_eq!(inbox.pending_count().unwrap(), 1);
    }

    #[test]
    fn spool_take_leaves_working_until_committed() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("box-a.outbox.jsonl"), "l1\nl2\n").unwrap();
        // First take returns the lines but LEAVES the .working file.
        let lines = take_spool(dir.path(), "box-a").unwrap();
        assert_eq!(lines, vec!["l1", "l2"]);
        assert!(
            dir.path().join("box-a.outbox.working").exists(),
            "working retained"
        );
        // A crash-restart before commit reclaims the SAME lines (no loss).
        let again = take_spool(dir.path(), "box-a").unwrap();
        assert_eq!(again, vec!["l1", "l2"]);
        // After commit the batch is gone.
        commit_spool(dir.path(), "box-a");
        assert!(take_spool(dir.path(), "box-a").unwrap().is_empty());
    }

    #[test]
    fn spool_take_folds_new_lines_into_recovered_working() {
        let dir = tempfile::tempdir().unwrap();
        // A .working left by a crash, plus fresh lines that arrived since.
        std::fs::write(dir.path().join("box-a.outbox.working"), "old\n").unwrap();
        std::fs::write(dir.path().join("box-a.outbox.jsonl"), "new\n").unwrap();
        let lines = take_spool(dir.path(), "box-a").unwrap();
        assert!(lines.contains(&"old".to_string()) && lines.contains(&"new".to_string()));
        assert!(!dir.path().join("box-a.outbox.jsonl").exists());
    }
}
