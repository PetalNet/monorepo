//! Agent capacity registry (CP10): the control plane's view of who exists,
//! what they provide, and how alive they look. Fed by `agent.capacity`
//! envelopes; liveness is DERIVED from report staleness (mirroring the
//! cockpit's offline derivation — producers never write it).

use std::collections::BTreeSet;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub const SUSPECT_AFTER_SECS: i64 = 90;
pub const DOWN_AFTER_SECS: i64 = 300;

/// The `agent.capacity` payload an agent/manager reports.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapacityReport {
    pub handle: String,
    #[serde(default)]
    pub provides: BTreeSet<String>,
    #[serde(default)]
    pub free_slots: u32,
    /// Host label, canonical form ('.N' for lab dot-hosts).
    #[serde(default)]
    pub host: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Liveness {
    Alive,
    /// Unresponsive but not yet declared dead (the SWIM suspicion state —
    /// treat as a pre-reap signal).
    Suspect,
    Down,
}

#[derive(Debug, Clone, Serialize)]
pub struct RegistryEntry {
    pub handle: String,
    pub provides: BTreeSet<String>,
    pub free_slots: u32,
    pub host: Option<String>,
    pub last_seen_epoch: i64,
    pub liveness: Liveness,
}

pub struct Registry {
    conn: Connection,
}

impl Registry {
    pub fn open(path: &Path) -> Result<Registry, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_millis(5000))
            .map_err(|e| e.to_string())?;
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS capacity (
                handle TEXT PRIMARY KEY,
                provides TEXT NOT NULL DEFAULT '[]',
                free_slots INTEGER NOT NULL DEFAULT 0,
                host TEXT,
                last_seen_epoch INTEGER NOT NULL
            );",
        )
        .map_err(|e| e.to_string())?;
        Ok(Registry { conn })
    }

    pub fn report(&self, r: &CapacityReport, now_epoch: i64) -> Result<(), String> {
        if !dispatcher::card::is_canonical_handle(&r.handle) {
            return Err(format!(
                "non-canonical handle {:?} in capacity report",
                r.handle
            ));
        }
        let provides = serde_json::to_string(&r.provides).map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "INSERT INTO capacity (handle, provides, free_slots, host, last_seen_epoch)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(handle) DO UPDATE SET provides=?2, free_slots=?3, host=?4,
                     last_seen_epoch=?5",
                params![r.handle, provides, r.free_slots, r.host, now_epoch],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get(&self, handle: &str, now_epoch: i64) -> Result<Option<RegistryEntry>, String> {
        self.conn
            .query_row(
                "SELECT handle, provides, free_slots, host, last_seen_epoch
                 FROM capacity WHERE handle=?1",
                params![handle],
                |row| row_to_entry(row, now_epoch),
            )
            .optional()
            .map_err(|e| e.to_string())
    }

    pub fn all(&self, now_epoch: i64) -> Result<Vec<RegistryEntry>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT handle, provides, free_slots, host, last_seen_epoch
                 FROM capacity ORDER BY handle",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row_to_entry(row, now_epoch))
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<_>>()
            .map_err(|e| e.to_string())
    }

    /// The push-routing pick: the single best ALIVE agent with a free slot
    /// providing every needed tag (most free slots wins — crude load
    /// balancing until real rank scores arrive).
    pub fn best_eligible(
        &self,
        needs: &BTreeSet<String>,
        now_epoch: i64,
    ) -> Result<Option<RegistryEntry>, String> {
        let mut best: Option<RegistryEntry> = None;
        for entry in self.all(now_epoch)? {
            if entry.liveness != Liveness::Alive
                || entry.free_slots == 0
                || !needs.is_subset(&entry.provides)
            {
                continue;
            }
            if best
                .as_ref()
                .map(|b| entry.free_slots > b.free_slots)
                .unwrap_or(true)
            {
                best = Some(entry);
            }
        }
        Ok(best)
    }
}

fn row_to_entry(row: &rusqlite::Row<'_>, now_epoch: i64) -> rusqlite::Result<RegistryEntry> {
    let provides_json: String = row.get(1)?;
    let last_seen_epoch: i64 = row.get(4)?;
    let age = now_epoch - last_seen_epoch;
    Ok(RegistryEntry {
        handle: row.get(0)?,
        provides: serde_json::from_str(&provides_json).unwrap_or_default(),
        free_slots: row.get::<_, i64>(2)? as u32,
        host: row.get(3)?,
        last_seen_epoch,
        liveness: if age > DOWN_AFTER_SECS {
            Liveness::Down
        } else if age > SUSPECT_AFTER_SECS {
            Liveness::Suspect
        } else {
            Liveness::Alive
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(handle: &str, provides: &[&str], slots: u32) -> CapacityReport {
        CapacityReport {
            handle: handle.into(),
            provides: provides.iter().map(|s| s.to_string()).collect(),
            free_slots: slots,
            host: Some(".14".into()),
        }
    }

    #[test]
    fn liveness_is_derived_from_staleness() {
        let dir = tempfile::tempdir().unwrap();
        let r = Registry::open(&dir.path().join("reg.db")).unwrap();
        r.report(&report("box-a", &["code"], 2), 1000).unwrap();
        assert_eq!(
            r.get("box-a", 1010).unwrap().unwrap().liveness,
            Liveness::Alive
        );
        assert_eq!(
            r.get("box-a", 1000 + 91).unwrap().unwrap().liveness,
            Liveness::Suspect
        );
        assert_eq!(
            r.get("box-a", 1000 + 301).unwrap().unwrap().liveness,
            Liveness::Down
        );
        // A fresh report revives it.
        r.report(&report("box-a", &["code"], 2), 2000).unwrap();
        assert_eq!(
            r.get("box-a", 2010).unwrap().unwrap().liveness,
            Liveness::Alive
        );
    }

    #[test]
    fn best_eligible_gates_and_prefers_free_slots() {
        let dir = tempfile::tempdir().unwrap();
        let r = Registry::open(&dir.path().join("reg.db")).unwrap();
        r.report(&report("busy", &["code", "gpu"], 0), 1000)
            .unwrap();
        r.report(&report("small", &["code", "gpu"], 1), 1000)
            .unwrap();
        r.report(&report("big", &["code", "gpu"], 4), 1000).unwrap();
        r.report(&report("wrongcaps", &["voice"], 8), 1000).unwrap();
        r.report(&report("stale", &["code", "gpu"], 9), 100)
            .unwrap();

        let needs: BTreeSet<String> = ["gpu".to_string()].into_iter().collect();
        let best = r.best_eligible(&needs, 1010).unwrap().unwrap();
        assert_eq!(
            best.handle, "big",
            "most free slots among alive+capable+free"
        );
        // Nobody provides 'quantum'.
        let none: BTreeSet<String> = ["quantum".to_string()].into_iter().collect();
        assert!(r.best_eligible(&none, 1010).unwrap().is_none());
    }

    #[test]
    fn hostile_handles_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let r = Registry::open(&dir.path().join("reg.db")).unwrap();
        assert!(r.report(&report("../evil", &[], 1), 0).is_err());
        assert!(r.report(&report("UPPER", &[], 1), 0).is_err());
    }
}
