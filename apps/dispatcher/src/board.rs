//! The wanted board — the bus's durable card store (dispatcher-owned SQLite,
//! never the live tracker DB; DP2).
//!
//! Lifecycle (collab-wanted-board):
//!
//! ```text
//! posted ──(no eligible agent)──▶ parked ──(capacity change)──▶ posted
//!   │ claim (CAS, prefetch=1)
//!   ▼
//! claimed/leased ──ack──▶ done
//!   │ lease expiry, reap (fence++)
//!   ├──(reaps < max)──▶ posted
//!   └──(reaps ≥ max)──▶ dead   (dead-letter, human triage)
//! ```
//!
//! Correctness rules, all enforced as single guarded UPDATEs (SQLite
//! single-statement atomicity = the CAS):
//! - A claim can only win from `posted`; exactly one winner.
//! - Every write under a lease carries (worker, fence); a stale fence is
//!   rejected, so a delayed/zombie worker cannot commit after reap+reclaim
//!   (queue-lease contract, `fence`).
//! - Surfacing: hard capability gate (`needs ⊆ provides`, resolved by the
//!   caller via the roster) + `(3 - priority) + k·age_minutes` aging score so
//!   low-priority cards can't starve (DP5).

use std::collections::BTreeSet;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use crate::card::{InterruptPolicy, SenderClass, TaskCard, TASK_CARD_SCHEMA_VERSION};

pub const DEFAULT_LEASE_MS: i64 = 30 * 60 * 1000;
pub const DEFAULT_MAX_REAPS: i64 = 3;

/// A card row as stored on the board. `recipient` is nullable while posted
/// (open pool work) and resolved at routing/claim time (DP6).
#[derive(Debug, Clone)]
pub struct BoardCard {
    pub card_id: String,
    pub task_id: i64,
    pub sender: String,
    pub sender_class: SenderClass,
    pub recipient: Option<String>,
    pub priority: u8,
    pub thread: Option<String>,
    pub requires_reply: bool,
    pub interrupt_policy: InterruptPolicy,
    pub body: String,
    pub needs: BTreeSet<String>,
    pub state: String,
    pub claimed_by: Option<String>,
    pub lease_expires_at_ms: Option<i64>,
    pub fence: i64,
    pub reaps: i64,
    pub reply_to: Option<String>,
    pub parent_id: Option<String>,
    pub result: Option<String>,
    pub created_at_ms: i64,
}

/// What to post: the dispatcher-facing subset (ids/fences are the board's).
#[derive(Debug, Clone)]
pub struct NewCard {
    pub task_id: i64,
    pub sender: String,
    pub sender_class: SenderClass,
    /// Some(handle) = addressed (push); None = open pool work (pull).
    pub recipient: Option<String>,
    pub priority: u8,
    pub thread: Option<String>,
    pub requires_reply: bool,
    pub interrupt_policy: InterruptPolicy,
    pub body: String,
    pub needs: BTreeSet<String>,
    pub reply_to: Option<String>,
    pub parent_id: Option<String>,
}

pub struct Board {
    conn: Connection,
    /// Aging factor: score = (3 - priority) + k * age_minutes.
    pub aging_k: f64,
    pub max_reaps: i64,
}

#[derive(Debug)]
pub enum BoardError {
    Db(rusqlite::Error),
    /// The guarded UPDATE matched no row: lost race, stale fence, or wrong state.
    Conflict(&'static str),
}

impl std::fmt::Display for BoardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BoardError::Db(e) => write!(f, "board db error: {e}"),
            BoardError::Conflict(what) => write!(f, "board conflict: {what}"),
        }
    }
}

impl std::error::Error for BoardError {}

impl From<rusqlite::Error> for BoardError {
    fn from(e: rusqlite::Error) -> Self {
        BoardError::Db(e)
    }
}

type Result<T> = std::result::Result<T, BoardError>;

impl Board {
    pub fn open(path: &Path) -> Result<Board> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Board> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Board> {
        conn.busy_timeout(std::time::Duration::from_millis(5000))?;
        conn.pragma_update(None, "journal_mode", "WAL").ok(); // in-memory DBs reject WAL; fine
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS cards (
                card_id          TEXT PRIMARY KEY,
                task_id          INTEGER NOT NULL,
                sender           TEXT NOT NULL,
                sender_class     TEXT NOT NULL CHECK (sender_class IN ('principal','agent','system')),
                recipient        TEXT,
                priority         INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 3),
                thread           TEXT,
                requires_reply   INTEGER NOT NULL DEFAULT 0,
                interrupt_policy TEXT NOT NULL CHECK (interrupt_policy IN
                                   ('defer','principal_command','safety','task_clarification')),
                body             TEXT NOT NULL,
                needs            TEXT NOT NULL DEFAULT '[]',
                state            TEXT NOT NULL DEFAULT 'posted' CHECK (state IN
                                   ('posted','parked','claimed','done','dead')),
                claimed_by       TEXT,
                lease_expires_at_ms INTEGER,
                fence            INTEGER NOT NULL DEFAULT 0,
                reaps            INTEGER NOT NULL DEFAULT 0,
                reply_to         TEXT,
                parent_id        TEXT,
                result           TEXT,
                delivered        INTEGER NOT NULL DEFAULT 0,
                created_at_ms    INTEGER NOT NULL,
                updated_at_ms    INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_cards_surface ON cards (state, priority, created_at_ms);
            CREATE INDEX IF NOT EXISTS idx_cards_lease ON cards (state, lease_expires_at_ms);
            CREATE INDEX IF NOT EXISTS idx_cards_recipient ON cards (recipient, state);",
        )?;
        Ok(Board {
            conn,
            aging_k: 0.05,
            max_reaps: DEFAULT_MAX_REAPS,
        })
    }

    pub fn post(&self, new: &NewCard, now_ms: i64) -> Result<String> {
        let card_id = uuid::Uuid::new_v4().to_string();
        let needs_json = serde_json::to_string(&new.needs).expect("btreeset serializes");
        self.conn.execute(
            "INSERT INTO cards (card_id, task_id, sender, sender_class, recipient, priority,
                thread, requires_reply, interrupt_policy, body, needs, state, reply_to,
                parent_id, created_at_ms, updated_at_ms)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'posted',?12,?13,?14,?14)",
            params![
                card_id,
                new.task_id,
                new.sender,
                sender_class_str(new.sender_class),
                new.recipient,
                new.priority,
                new.thread,
                new.requires_reply as i64,
                interrupt_policy_str(new.interrupt_policy),
                new.body,
                needs_json,
                new.reply_to,
                new.parent_id,
                now_ms
            ],
        )?;
        Ok(card_id)
    }

    /// The pull-mode surfacing query: best `posted` card this worker is
    /// eligible for, by aging score. Capability gating happens in SQL for the
    /// cheap part (addressed-to-me or unaddressed) and in the caller's roster
    /// check for `needs ⊆ provides` (CSV-in-SQL subset tests lie; DP5).
    /// prefetch=1: exactly one candidate is returned.
    pub fn surface(
        &self,
        worker: &str,
        provides: &BTreeSet<String>,
        now_ms: i64,
    ) -> Result<Option<BoardCard>> {
        let mut stmt = self.conn.prepare(
            "SELECT card_id, task_id, sender, sender_class, recipient, priority, thread,
                    requires_reply, interrupt_policy, body, needs, state, claimed_by,
                    lease_expires_at_ms, fence, reaps, reply_to, parent_id, result, created_at_ms
             FROM cards
             WHERE state = 'posted' AND (recipient IS NULL OR recipient = ?1)
             ORDER BY (3.0 - priority) + ?2 * ((?3 - created_at_ms) / 60000.0) DESC,
                      created_at_ms ASC",
        )?;
        let rows = stmt.query_map(params![worker, self.aging_k, now_ms], row_to_card)?;
        for row in rows {
            let card = row?;
            if card.needs.is_subset(provides) {
                return Ok(Some(card));
            }
        }
        Ok(None)
    }

    /// Atomic claim (CAS): wins only from `posted`; increments the fence and
    /// addresses the card to the winner. Losers get Conflict and should
    /// jitter-backoff onto another card.
    pub fn claim(
        &self,
        card_id: &str,
        worker: &str,
        lease_ms: i64,
        now_ms: i64,
    ) -> Result<BoardCard> {
        let n = self.conn.execute(
            "UPDATE cards SET state='claimed', claimed_by=?2, recipient=COALESCE(recipient, ?2),
                    lease_expires_at_ms=?3, fence=fence+1, updated_at_ms=?4
             WHERE card_id=?1 AND state='posted'",
            params![card_id, worker, now_ms + lease_ms, now_ms],
        )?;
        if n == 0 {
            return Err(BoardError::Conflict("claim lost (not posted)"));
        }
        Ok(self.get(card_id)?.expect("just updated"))
    }

    /// Lease heartbeat (ChangeMessageVisibility-style): only the current
    /// holder at the current fence may renew — slow-but-alive ≠ dead.
    pub fn renew(
        &self,
        card_id: &str,
        worker: &str,
        fence: i64,
        lease_ms: i64,
        now_ms: i64,
    ) -> Result<()> {
        let n = self.conn.execute(
            "UPDATE cards SET lease_expires_at_ms=?4, updated_at_ms=?5
             WHERE card_id=?1 AND state='claimed' AND claimed_by=?2 AND fence=?3",
            params![card_id, worker, fence, now_ms + lease_ms, now_ms],
        )?;
        if n == 0 {
            return Err(BoardError::Conflict(
                "renew rejected (stale fence or not holder)",
            ));
        }
        Ok(())
    }

    /// acks_late: done only on success, gated on (worker, fence). `result` is
    /// keyed by the correlation id (the card id) for the reply flow.
    pub fn complete(
        &self,
        card_id: &str,
        worker: &str,
        fence: i64,
        result: Option<&str>,
        now_ms: i64,
    ) -> Result<()> {
        let n = self.conn.execute(
            "UPDATE cards SET state='done', result=?4, lease_expires_at_ms=NULL, updated_at_ms=?5
             WHERE card_id=?1 AND state='claimed' AND claimed_by=?2 AND fence=?3",
            params![card_id, worker, fence, result, now_ms],
        )?;
        if n == 0 {
            return Err(BoardError::Conflict(
                "complete rejected (stale fence or not holder)",
            ));
        }
        Ok(())
    }

    /// Reap expired leases: crash → requeue (fence already advanced past the
    /// old holder's writes at next claim), N reaps → dead-letter. Returns
    /// (requeued, dead_lettered) card ids.
    pub fn reap(&self, now_ms: i64) -> Result<(Vec<String>, Vec<String>)> {
        let expired: Vec<String> = {
            let mut stmt = self.conn.prepare(
                "SELECT card_id FROM cards
                 WHERE state='claimed' AND lease_expires_at_ms IS NOT NULL
                   AND lease_expires_at_ms < ?1",
            )?;
            let ids = stmt.query_map(params![now_ms], |r| r.get::<_, String>(0))?;
            ids.collect::<rusqlite::Result<_>>()?
        };
        let mut requeued = Vec::new();
        let mut dead = Vec::new();
        for id in expired {
            let n = self.conn.execute(
                "UPDATE cards SET state='dead', claimed_by=NULL, lease_expires_at_ms=NULL,
                        reaps=reaps+1, updated_at_ms=?2
                 WHERE card_id=?1 AND state='claimed' AND lease_expires_at_ms < ?2
                   AND reaps+1 >= ?3",
                params![id, now_ms, self.max_reaps],
            )?;
            if n == 1 {
                dead.push(id);
                continue;
            }
            let n = self.conn.execute(
                "UPDATE cards SET state='posted', claimed_by=NULL, lease_expires_at_ms=NULL,
                        reaps=reaps+1, updated_at_ms=?2
                 WHERE card_id=?1 AND state='claimed' AND lease_expires_at_ms < ?2",
                params![id, now_ms],
            )?;
            if n == 1 {
                requeued.push(id);
            }
            // n == 0: the holder completed/renewed between SELECT and UPDATE — fine.
        }
        Ok((requeued, dead))
    }

    /// Park a posted card no eligible free agent exists for; re-woken by
    /// `wake_parked` on a capacity-change event (never hot-polled; DP13).
    pub fn park(&self, card_id: &str, now_ms: i64) -> Result<()> {
        let n = self.conn.execute(
            "UPDATE cards SET state='parked', updated_at_ms=?2 WHERE card_id=?1 AND state='posted'",
            params![card_id, now_ms],
        )?;
        if n == 0 {
            return Err(BoardError::Conflict("park rejected (not posted)"));
        }
        Ok(())
    }

    /// Capacity changed (an agent came free / registered): parked → posted.
    pub fn wake_parked(&self, now_ms: i64) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE cards SET state='posted', updated_at_ms=?1 WHERE state='parked'",
            params![now_ms],
        )?)
    }

    /// Deferred, not-yet-delivered cards for one recipient — digest input.
    pub fn deferred_for(&self, recipient: &str) -> Result<Vec<BoardCard>> {
        let mut stmt = self.conn.prepare(
            "SELECT card_id, task_id, sender, sender_class, recipient, priority, thread,
                    requires_reply, interrupt_policy, body, needs, state, claimed_by,
                    lease_expires_at_ms, fence, reaps, reply_to, parent_id, result, created_at_ms
             FROM cards
             WHERE recipient=?1 AND interrupt_policy='defer'
               AND state IN ('posted','claimed') AND delivered=0
             ORDER BY priority ASC, created_at_ms ASC",
        )?;
        let rows = stmt.query_map(params![recipient], row_to_card)?;
        rows.map(|r| r.map_err(BoardError::from)).collect()
    }

    /// Honored-interrupt cards whose delivery hasn't succeeded yet (the
    /// dispatch attempt failed) — the daemon retries these each pass so a
    /// transport outage never loses an interrupt (codex P1).
    pub fn undelivered_interrupts(&self) -> Result<Vec<BoardCard>> {
        let mut stmt = self.conn.prepare(
            "SELECT card_id, task_id, sender, sender_class, recipient, priority, thread,
                    requires_reply, interrupt_policy, body, needs, state, claimed_by,
                    lease_expires_at_ms, fence, reaps, reply_to, parent_id, result, created_at_ms
             FROM cards
             WHERE recipient IS NOT NULL AND interrupt_policy != 'defer'
               AND state IN ('posted','claimed') AND delivered=0
             ORDER BY priority ASC, created_at_ms ASC",
        )?;
        let rows = stmt.query_map([], row_to_card)?;
        rows.map(|r| r.map_err(BoardError::from)).collect()
    }

    /// Recipients that currently have undelivered deferred cards (digest fan-out).
    pub fn distinct_deferred_recipients(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT recipient FROM cards
             WHERE recipient IS NOT NULL AND interrupt_policy='defer'
               AND state IN ('posted','claimed') AND delivered=0",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|r| r.map_err(BoardError::from)).collect()
    }

    /// Mark cards as surfaced-to-agent (the digest/interrupt actually went out).
    pub fn mark_delivered(&self, card_ids: &[String], now_ms: i64) -> Result<()> {
        for id in card_ids {
            self.conn.execute(
                "UPDATE cards SET delivered=1, updated_at_ms=?2 WHERE card_id=?1",
                params![id, now_ms],
            )?;
        }
        Ok(())
    }

    pub fn get(&self, card_id: &str) -> Result<Option<BoardCard>> {
        self.conn
            .query_row(
                "SELECT card_id, task_id, sender, sender_class, recipient, priority, thread,
                        requires_reply, interrupt_policy, body, needs, state, claimed_by,
                        lease_expires_at_ms, fence, reaps, reply_to, parent_id, result, created_at_ms
                 FROM cards WHERE card_id=?1",
                params![card_id],
                row_to_card,
            )
            .optional()
            .map_err(BoardError::from)
    }

    /// Render a board card into the wire task-card (contract shape). Requires
    /// a resolved recipient (DP6).
    pub fn to_task_card(card: &BoardCard, now_rfc3339: &str) -> Option<TaskCard> {
        let recipient = card.recipient.clone().or_else(|| card.claimed_by.clone())?;
        Some(TaskCard {
            schema_version: TASK_CARD_SCHEMA_VERSION,
            card_id: card.card_id.clone(),
            task_id: card.task_id,
            sender: card.sender.clone(),
            sender_class: card.sender_class,
            recipient,
            priority: card.priority,
            thread: card.thread.clone(),
            requires_reply: card.requires_reply,
            interrupt_policy: card.interrupt_policy,
            body: card.body.clone(),
            capability: card.needs.iter().next().cloned(),
            lease: None,
            created_at: now_rfc3339.to_string(),
            expires_at: None,
        })
    }
}

fn sender_class_str(c: SenderClass) -> &'static str {
    match c {
        SenderClass::Principal => "principal",
        SenderClass::Agent => "agent",
        SenderClass::System => "system",
    }
}

fn interrupt_policy_str(p: InterruptPolicy) -> &'static str {
    match p {
        InterruptPolicy::Defer => "defer",
        InterruptPolicy::PrincipalCommand => "principal_command",
        InterruptPolicy::Safety => "safety",
        InterruptPolicy::TaskClarification => "task_clarification",
    }
}

fn parse_sender_class(s: &str) -> SenderClass {
    match s {
        "principal" => SenderClass::Principal,
        "system" => SenderClass::System,
        _ => SenderClass::Agent,
    }
}

fn parse_interrupt_policy(s: &str) -> InterruptPolicy {
    match s {
        "principal_command" => InterruptPolicy::PrincipalCommand,
        "safety" => InterruptPolicy::Safety,
        "task_clarification" => InterruptPolicy::TaskClarification,
        _ => InterruptPolicy::Defer,
    }
}

fn row_to_card(row: &rusqlite::Row<'_>) -> rusqlite::Result<BoardCard> {
    let sender_class: String = row.get(3)?;
    let interrupt_policy: String = row.get(8)?;
    let needs_json: String = row.get(10)?;
    Ok(BoardCard {
        card_id: row.get(0)?,
        task_id: row.get(1)?,
        sender: row.get(2)?,
        sender_class: parse_sender_class(&sender_class),
        recipient: row.get(4)?,
        priority: row.get::<_, i64>(5)? as u8,
        thread: row.get(6)?,
        requires_reply: row.get::<_, i64>(7)? != 0,
        interrupt_policy: parse_interrupt_policy(&interrupt_policy),
        body: row.get(9)?,
        needs: serde_json::from_str(&needs_json).unwrap_or_default(),
        state: row.get(11)?,
        claimed_by: row.get(12)?,
        lease_expires_at_ms: row.get(13)?,
        fence: row.get(14)?,
        reaps: row.get(15)?,
        reply_to: row.get(16)?,
        parent_id: row.get(17)?,
        result: row.get(18)?,
        created_at_ms: row.get(19)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new_card(priority: u8, needs: &[&str]) -> NewCard {
        NewCard {
            task_id: 670,
            sender: "@parker:petalnet.example".into(),
            sender_class: SenderClass::Principal,
            recipient: None,
            priority,
            thread: None,
            requires_reply: false,
            interrupt_policy: InterruptPolicy::Defer,
            body: "do the thing".into(),
            needs: needs.iter().map(|s| s.to_string()).collect(),
            reply_to: None,
            parent_id: None,
        }
    }

    fn provides(tags: &[&str]) -> BTreeSet<String> {
        tags.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn claim_is_exactly_once() {
        let b = Board::open_in_memory().unwrap();
        let id = b.post(&new_card(1, &[]), 1000).unwrap();
        let won = b.claim(&id, "worker-a", DEFAULT_LEASE_MS, 2000).unwrap();
        assert_eq!(won.claimed_by.as_deref(), Some("worker-a"));
        assert_eq!(won.fence, 1);
        // The loser gets a conflict, not a duplicate card.
        let lost = b.claim(&id, "worker-b", DEFAULT_LEASE_MS, 2001);
        assert!(matches!(lost, Err(BoardError::Conflict(_))));
    }

    #[test]
    fn stale_fence_cannot_commit_after_reap_and_reclaim() {
        let b = Board::open_in_memory().unwrap();
        let id = b.post(&new_card(1, &[]), 0).unwrap();
        let old = b.claim(&id, "worker-a", 1000, 0).unwrap(); // fence 1, expires at 1000
                                                              // Lease expires; reap requeues; another worker reclaims (fence 2).
        let (requeued, dead) = b.reap(5000).unwrap();
        assert_eq!(requeued, vec![id.clone()]);
        assert!(dead.is_empty());
        let fresh = b.claim(&id, "worker-b", 60_000, 6000).unwrap();
        assert_eq!(fresh.fence, 2);
        // The zombie's writes carry fence 1 and MUST be rejected.
        assert!(b
            .complete(&id, "worker-a", old.fence, Some("late"), 7000)
            .is_err());
        assert!(b.renew(&id, "worker-a", old.fence, 1000, 7000).is_err());
        // The live holder commits fine.
        b.complete(&id, "worker-b", fresh.fence, Some("ok"), 8000)
            .unwrap();
        assert_eq!(b.get(&id).unwrap().unwrap().state, "done");
    }

    #[test]
    fn repeated_reaps_dead_letter() {
        let b = Board::open_in_memory().unwrap();
        let id = b.post(&new_card(0, &[]), 0).unwrap();
        for round in 0..DEFAULT_MAX_REAPS {
            let now = round * 10_000;
            b.claim(&id, "flaky", 1000, now).unwrap();
            let (requeued, dead) = b.reap(now + 5000).unwrap();
            if round < DEFAULT_MAX_REAPS - 1 {
                assert_eq!(requeued, vec![id.clone()], "round {round}");
                assert!(dead.is_empty());
            } else {
                assert!(requeued.is_empty());
                assert_eq!(dead, vec![id.clone()], "third reap dead-letters");
            }
        }
        assert_eq!(b.get(&id).unwrap().unwrap().state, "dead");
    }

    #[test]
    fn surfacing_gates_on_capability_subset() {
        let b = Board::open_in_memory().unwrap();
        let gpu = b.post(&new_card(0, &["gpu"]), 0).unwrap();
        let code = b.post(&new_card(2, &["code"]), 0).unwrap();
        // A code-only worker never sees the gpu card, even though it's P0.
        let got = b
            .surface("w", &provides(&["code"]), 60_000)
            .unwrap()
            .unwrap();
        assert_eq!(got.card_id, code);
        // A gpu+code worker gets the P0 gpu card first.
        let got = b
            .surface("w", &provides(&["code", "gpu"]), 60_000)
            .unwrap()
            .unwrap();
        assert_eq!(got.card_id, gpu);
    }

    #[test]
    fn aging_overtakes_priority() {
        // Default k=0.05: a P3 card needs 3 score points = 60 min of age to tie a fresh P0.
        let b = Board::open_in_memory().unwrap();
        let old_p3 = b.post(&new_card(3, &[]), 0).unwrap();
        let _new_p0 = b.post(&new_card(0, &[]), 0).unwrap();
        // At t=0 the P0 card wins…
        let first = b.surface("w", &provides(&[]), 0).unwrap().unwrap();
        assert_ne!(first.card_id, old_p3);
        // …but 61+ minutes later the aged P3 card overtakes (no starvation).
        // Both share created_at, so age is equal — recreate the real scenario:
        let b2 = Board::open_in_memory().unwrap();
        let aged = b2.post(&new_card(3, &[]), 0).unwrap();
        let _fresh = b2.post(&new_card(0, &[]), 90 * 60_000).unwrap();
        let got = b2
            .surface("w", &provides(&[]), 91 * 60_000)
            .unwrap()
            .unwrap();
        assert_eq!(got.card_id, aged, "aged P3 overtakes fresh P0");
    }

    #[test]
    fn addressed_cards_only_surface_to_their_recipient() {
        let b = Board::open_in_memory().unwrap();
        let mut c = new_card(1, &[]);
        c.recipient = Some("janet".into());
        let id = b.post(&c, 0).unwrap();
        assert!(b.surface("other", &provides(&[]), 1000).unwrap().is_none());
        let got = b.surface("janet", &provides(&[]), 1000).unwrap().unwrap();
        assert_eq!(got.card_id, id);
    }

    #[test]
    fn park_and_capacity_wake() {
        let b = Board::open_in_memory().unwrap();
        let id = b.post(&new_card(1, &["voice"]), 0).unwrap();
        b.park(&id, 1000).unwrap();
        assert!(b
            .surface("w", &provides(&["voice"]), 2000)
            .unwrap()
            .is_none());
        assert_eq!(b.wake_parked(3000).unwrap(), 1);
        assert!(b
            .surface("w", &provides(&["voice"]), 4000)
            .unwrap()
            .is_some());
    }

    #[test]
    fn to_task_card_requires_resolved_recipient() {
        let b = Board::open_in_memory().unwrap();
        let id = b.post(&new_card(1, &["code"]), 0).unwrap();
        let card = b.get(&id).unwrap().unwrap();
        assert!(Board::to_task_card(&card, "2026-07-12T11:00:00Z").is_none());
        let claimed = b.claim(&id, "janet", DEFAULT_LEASE_MS, 1000).unwrap();
        let wire = Board::to_task_card(&claimed, "2026-07-12T11:00:00Z").unwrap();
        assert_eq!(wire.recipient, "janet");
        assert_eq!(wire.schema_version, TASK_CARD_SCHEMA_VERSION);
    }
}
