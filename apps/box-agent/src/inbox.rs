//! Inbound envelope consumption with persistent dedup (BA3).
//!
//! Contract D20: delivery may be retried after a redial with the SAME
//! envelope id — receivers MUST de-duplicate. The box-agent persists seen
//! envelope ids (and accepted card ids) in its own SQLite so a restart
//! doesn't re-run work that a redelivery then re-sends.

use std::path::Path;

use rusqlite::{params, Connection};

use dispatcher::envelope::Envelope;

pub struct Inbox {
    conn: Connection,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Accept {
    /// First sight of this envelope id — process it.
    Fresh,
    /// Already seen (redelivery/replay) — acknowledge but do not re-run.
    Duplicate,
}

impl Inbox {
    pub fn open(path: &Path) -> Result<Inbox, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_millis(5000))
            .map_err(|e| e.to_string())?;
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS seen (
                kind TEXT NOT NULL,
                id   TEXT NOT NULL,
                seen_at_ms INTEGER NOT NULL,
                PRIMARY KEY (kind, id)
            );",
        )
        .map_err(|e| e.to_string())?;
        Ok(Inbox { conn })
    }

    /// Record (kind, id); INSERT OR IGNORE makes the check-and-mark atomic.
    fn mark(&self, kind: &str, id: &str, now_ms: i64) -> Result<Accept, String> {
        let n = self
            .conn
            .execute(
                "INSERT OR IGNORE INTO seen (kind, id, seen_at_ms) VALUES (?1, ?2, ?3)",
                params![kind, id, now_ms],
            )
            .map_err(|e| e.to_string())?;
        Ok(if n == 1 {
            Accept::Fresh
        } else {
            Accept::Duplicate
        })
    }

    /// Dedup an envelope by id (all kinds).
    pub fn accept_envelope(&self, envelope: &Envelope, now_ms: i64) -> Result<Accept, String> {
        self.mark("envelope", &envelope.id, now_ms)
    }

    /// Additional dedup for task.dispatch payload cards: a replayed message
    /// can arrive under a NEW envelope id but the same card id.
    pub fn accept_card(&self, card_id: &str, now_ms: i64) -> Result<Accept, String> {
        self.mark("card", card_id, now_ms)
    }
}

/// Consume the box-agent's spool: `<inbox_dir>/<handle>.outbox.jsonl` (the
/// dispatcher's SpoolTransport appends there). Files are renamed before
/// reading (atomic take) exactly like the dispatcher's ingest; the persistent
/// dedup makes the at-least-once replay harmless.
pub fn take_spool_lines(inbox_dir: &Path, handle: &str) -> Result<Vec<String>, String> {
    let mut lines = Vec::new();
    // Startup/crash recovery: reclaim any .working file first.
    for suffix in ["outbox.working", "outbox.jsonl"] {
        let path = inbox_dir.join(format!("{handle}.{suffix}"));
        if suffix.ends_with(".working") {
            let _ = std::fs::rename(&path, inbox_dir.join(format!("{handle}.outbox.jsonl")));
            continue;
        }
        if !path.exists() {
            continue;
        }
        let working = inbox_dir.join(format!("{handle}.outbox.working"));
        if std::fs::rename(&path, &working).is_err() {
            continue;
        }
        let content = std::fs::read_to_string(&working).map_err(|e| e.to_string())?;
        lines.extend(content.lines().map(str::to_string));
        let _ = std::fs::remove_file(&working);
    }
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dispatcher::envelope::{Envelope, EnvelopeType};

    fn envelope(id: &str) -> Envelope {
        Envelope {
            schema_version: 1,
            id: id.into(),
            kind: EnvelopeType::Heartbeat,
            method: None,
            agent: "box-a".into(),
            task_id: None,
            in_reply_to: None,
            payload: None,
            error: None,
            ts: "2026-07-12T11:00:00Z".into(),
            deadline_ms: None,
        }
    }

    #[test]
    fn envelope_dedup_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("inbox.db");
        {
            let inbox = Inbox::open(&db).unwrap();
            assert_eq!(
                inbox.accept_envelope(&envelope("e1"), 0).unwrap(),
                Accept::Fresh
            );
            assert_eq!(
                inbox.accept_envelope(&envelope("e1"), 1).unwrap(),
                Accept::Duplicate
            );
        }
        // Restart: the dedup table is durable.
        let inbox = Inbox::open(&db).unwrap();
        assert_eq!(
            inbox.accept_envelope(&envelope("e1"), 2).unwrap(),
            Accept::Duplicate
        );
        assert_eq!(
            inbox.accept_envelope(&envelope("e2"), 3).unwrap(),
            Accept::Fresh
        );
    }

    #[test]
    fn card_dedup_is_independent_of_envelope_dedup() {
        let dir = tempfile::tempdir().unwrap();
        let inbox = Inbox::open(&dir.path().join("inbox.db")).unwrap();
        // Same card under two envelope ids: the card runs once.
        assert_eq!(
            inbox.accept_envelope(&envelope("e1"), 0).unwrap(),
            Accept::Fresh
        );
        assert_eq!(inbox.accept_card("c1", 0).unwrap(), Accept::Fresh);
        assert_eq!(
            inbox.accept_envelope(&envelope("e2"), 1).unwrap(),
            Accept::Fresh
        );
        assert_eq!(inbox.accept_card("c1", 1).unwrap(), Accept::Duplicate);
    }

    #[test]
    fn spool_take_consumes_and_recovers() {
        let dir = tempfile::tempdir().unwrap();
        let spool = dir.path().join("box-a.outbox.jsonl");
        std::fs::write(&spool, "line1\nline2\n").unwrap();
        let lines = take_spool_lines(dir.path(), "box-a").unwrap();
        assert_eq!(lines, vec!["line1", "line2"]);
        assert!(!spool.exists(), "consumed");
        assert!(take_spool_lines(dir.path(), "box-a").unwrap().is_empty());
        // Crash recovery: a leftover .working file is reclaimed next pass.
        std::fs::write(dir.path().join("box-a.outbox.working"), "line3\n").unwrap();
        let lines = take_spool_lines(dir.path(), "box-a").unwrap();
        assert_eq!(lines, vec!["line3"]);
    }
}
