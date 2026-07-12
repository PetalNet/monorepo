//! The dispatcher's roster: who is a principal, which agents exist, and what
//! capabilities each provides. `sender_class` stamping comes from HERE, never
//! from the sender's own claim (contract D16).
//!
//! Sources: principals from dispatcher config (Matrix user ids); agents from a
//! registry snapshot — either a JSON file or the tasks `agents` table shape
//! (handle, capabilities CSV, active). The registry is read-only to us: the
//! tracker owns it.

use std::collections::{BTreeMap, BTreeSet};

use serde::Deserialize;

use crate::card::SenderClass;

#[derive(Debug, Clone, Deserialize)]
pub struct AgentEntry {
    pub handle: String,
    /// Capability tags this agent MAY work (the lane gate).
    #[serde(default)]
    pub capabilities: BTreeSet<String>,
    #[serde(default = "default_true")]
    pub active: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Default)]
pub struct Roster {
    principals: BTreeSet<String>,
    agents: BTreeMap<String, AgentEntry>,
}

impl Roster {
    pub fn new(principals: impl IntoIterator<Item = String>) -> Self {
        Roster {
            principals: principals.into_iter().collect(),
            agents: BTreeMap::new(),
        }
    }

    pub fn upsert_agent(&mut self, entry: AgentEntry) {
        self.agents.insert(entry.handle.to_ascii_lowercase(), entry);
    }

    /// Load agents from the registry table shape (`agents`: handle,
    /// capabilities CSV, active). Used against temp/test DBs; live wiring is
    /// cutover work (DP2).
    pub fn load_agents_from_db(&mut self, conn: &rusqlite::Connection) -> rusqlite::Result<usize> {
        let mut stmt = conn.prepare("SELECT handle, capabilities, active FROM agents")?;
        let rows = stmt.query_map([], |row| {
            let handle: String = row.get(0)?;
            let caps: String = row.get(1)?;
            let active: i64 = row.get(2)?;
            Ok(AgentEntry {
                handle,
                capabilities: caps
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect(),
                active: active != 0,
            })
        })?;
        let mut n = 0;
        for row in rows {
            self.upsert_agent(row?);
            n += 1;
        }
        Ok(n)
    }

    /// Stamp the sender class from OUR roster. A sender that is neither a
    /// principal nor a registered agent is classed `agent` (an unknown outside
    /// identity gets no interrupt privilege and no system authority).
    pub fn classify(&self, sender: &str) -> SenderClass {
        if self.principals.contains(sender) {
            SenderClass::Principal
        } else if sender == "dispatcher" || sender.starts_with("system:") {
            SenderClass::System
        } else {
            SenderClass::Agent
        }
    }

    pub fn is_active_agent(&self, handle: &str) -> bool {
        self.agents
            .get(&handle.to_ascii_lowercase())
            .map(|a| a.active)
            .unwrap_or(false)
    }

    /// Hard capability gate: does `handle` provide every needed tag?
    pub fn provides_all(&self, handle: &str, needs: &BTreeSet<String>) -> bool {
        match self.agents.get(&handle.to_ascii_lowercase()) {
            Some(a) if a.active => needs.is_subset(&a.capabilities),
            _ => false,
        }
    }

    /// Active agents eligible for `needs` (the push-routing candidate pool).
    pub fn eligible(&self, needs: &BTreeSet<String>) -> Vec<&AgentEntry> {
        self.agents
            .values()
            .filter(|a| a.active && needs.is_subset(&a.capabilities))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roster() -> Roster {
        let mut r = Roster::new(vec![
            "@parker:petalnet.example".to_string(),
            "@eli:petalnet.example".to_string(),
        ]);
        r.upsert_agent(AgentEntry {
            handle: "janet".into(),
            capabilities: ["matrix-write", "code"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            active: true,
        });
        r.upsert_agent(AgentEntry {
            handle: "retired-bot".into(),
            capabilities: ["code"].iter().map(|s| s.to_string()).collect(),
            active: false,
        });
        r
    }

    #[test]
    fn principals_come_from_config_only() {
        let r = roster();
        assert_eq!(
            r.classify("@parker:petalnet.example"),
            SenderClass::Principal
        );
        assert_eq!(r.classify("@mallory:evil.example"), SenderClass::Agent);
        assert_eq!(r.classify("janet"), SenderClass::Agent);
        assert_eq!(r.classify("dispatcher"), SenderClass::System);
        assert_eq!(r.classify("system:watchdog"), SenderClass::System);
    }

    #[test]
    fn capability_gate_is_subset_and_active_only() {
        let r = roster();
        let needs: BTreeSet<String> = ["code".to_string()].into();
        assert!(r.provides_all("janet", &needs));
        assert!(
            !r.provides_all("retired-bot", &needs),
            "inactive never matches"
        );
        assert!(!r.provides_all("nobody", &needs));
        let gpu: BTreeSet<String> = ["gpu".to_string()].into();
        assert!(!r.provides_all("janet", &gpu));
        assert_eq!(r.eligible(&needs).len(), 1);
    }

    #[test]
    fn agents_load_from_registry_table_shape() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE agents (handle TEXT PRIMARY KEY, display_name TEXT DEFAULT '',
             host TEXT DEFAULT '', role TEXT DEFAULT '', lane TEXT DEFAULT 'open',
             capabilities TEXT DEFAULT '', autonomy TEXT DEFAULT 'ask',
             active INTEGER NOT NULL DEFAULT 1,
             created_at TEXT NOT NULL DEFAULT (datetime('now')),
             updated_at TEXT NOT NULL DEFAULT (datetime('now')));
             INSERT INTO agents (handle, capabilities, active) VALUES
               ('janet', 'matrix-write, code', 1),
               ('ghost', 'code', 0);",
        )
        .unwrap();
        let mut r = Roster::new(vec![]);
        assert_eq!(r.load_agents_from_db(&conn).unwrap(), 2);
        let needs: BTreeSet<String> = ["matrix-write".to_string()].into();
        assert!(r.provides_all("janet", &needs));
        assert!(!r.is_active_agent("ghost"));
    }
}
