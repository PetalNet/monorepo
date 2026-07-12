//! Tracker access behind a trait (DP2).
//!
//! The tracker (tasks.db) is the fleet's source of truth and has a SINGLE
//! writer — the tasks app. The dispatcher needs exactly two things from it:
//! file a task for brand-new work (a card is created AFTER the task exists,
//! LOCKED spawn-from-task), and read the recipient's active lease (the
//! task_clarification honor condition). Both sit behind `Tracker` so tests
//! run on temp DBs and the live wiring (tasks HTTP/MCP API) is a cutover
//! decision, not a code change here.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

pub trait Tracker: Send {
    /// File a new task for inbound work; returns the tracker task id.
    fn file_task(
        &self,
        title: &str,
        body: &str,
        priority: u8,
        created_by: &str,
    ) -> Result<i64, String>;

    /// The task currently leased by `worker` (status='doing', unexpired), if any.
    fn active_lease(&self, worker: &str) -> Result<Option<i64>, String>;
}

/// SQLite implementation against the tasks schema. Used with temp DBs in
/// tests and disposable-agent runs (TASKS_DB_PATH-style); NEVER pointed at
/// the live tracker from this process (DP2).
pub struct SqliteTracker {
    conn: Connection,
}

impl SqliteTracker {
    pub fn open(path: &Path) -> Result<SqliteTracker, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_millis(5000))
            .map_err(|e| e.to_string())?;
        Ok(SqliteTracker { conn })
    }

    /// Minimal tasks-shaped schema for temp/test DBs (subset of the live
    /// columns the dispatcher touches).
    pub fn init_test_schema(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS tasks (
                    id INTEGER PRIMARY KEY,
                    kind TEXT NOT NULL DEFAULT 'task',
                    title TEXT NOT NULL,
                    body TEXT DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'todo',
                    priority INTEGER NOT NULL DEFAULT 2,
                    created_by TEXT DEFAULT '',
                    claimed_by TEXT DEFAULT '',
                    lease_expires_at TEXT,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );",
            )
            .map_err(|e| e.to_string())
    }
}

impl Tracker for SqliteTracker {
    fn file_task(
        &self,
        title: &str,
        body: &str,
        priority: u8,
        created_by: &str,
    ) -> Result<i64, String> {
        self.conn
            .execute(
                "INSERT INTO tasks (title, body, priority, status, created_by)
                 VALUES (?1, ?2, ?3, 'todo', ?4)",
                params![title, body, priority, created_by],
            )
            .map_err(|e| e.to_string())?;
        Ok(self.conn.last_insert_rowid())
    }

    fn active_lease(&self, worker: &str) -> Result<Option<i64>, String> {
        // Live shape: lease_expires_at is 'YYYY-MM-DD HH:MM:SS' UTC; expired
        // leases are reap-pending and must NOT count as active.
        self.conn
            .query_row(
                "SELECT id FROM tasks
                 WHERE status='doing' AND claimed_by=?1
                   AND lease_expires_at IS NOT NULL
                   AND lease_expires_at > strftime('%Y-%m-%d %H:%M:%S','now')
                 ORDER BY lease_expires_at DESC LIMIT 1",
                params![worker],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tracker() -> SqliteTracker {
        let t = SqliteTracker {
            conn: Connection::open_in_memory().unwrap(),
        };
        t.init_test_schema().unwrap();
        t
    }

    #[test]
    fn file_task_returns_id_and_status_todo() {
        let t = tracker();
        let id = t.file_task("ping janet", "body", 2, "dispatcher").unwrap();
        assert!(id >= 1);
        let status: String = t
            .conn
            .query_row("SELECT status FROM tasks WHERE id=?1", params![id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(status, "todo");
    }

    #[test]
    fn active_lease_ignores_expired_and_other_workers() {
        let t = tracker();
        let id = t.file_task("work", "", 1, "dispatcher").unwrap();
        // Unexpired lease for janet.
        t.conn
            .execute(
                "UPDATE tasks SET status='doing', claimed_by='janet',
                 lease_expires_at=strftime('%Y-%m-%d %H:%M:%S','now','+30 minutes') WHERE id=?1",
                params![id],
            )
            .unwrap();
        assert_eq!(t.active_lease("janet").unwrap(), Some(id));
        assert_eq!(t.active_lease("other").unwrap(), None);
        // Expired lease no longer counts.
        t.conn
            .execute(
                "UPDATE tasks SET lease_expires_at=strftime('%Y-%m-%d %H:%M:%S','now','-1 minute')
                 WHERE id=?1",
                params![id],
            )
            .unwrap();
        assert_eq!(t.active_lease("janet").unwrap(), None);
    }
}
