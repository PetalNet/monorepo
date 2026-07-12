//! Dispatcher config — deny-unknown-fields, manager-config convention (DP12):
//! this process is harness-critical, so a typo'd key fails loudly at boot.

use std::path::PathBuf;

use serde::Deserialize;

pub const CONFIG_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// Optional, const 1 (absence = 1) — manager-config convention.
    #[serde(default)]
    pub schema_version: Option<u32>,
    /// The board DB (dispatcher-owned; NEVER the live tracker DB).
    pub db_path: PathBuf,
    /// Tracker DB for file_task/active_lease. Optional: absent = tracker
    /// integration disabled (cards must carry an existing task_id).
    #[serde(default)]
    pub tracker_db_path: Option<PathBuf>,
    /// Matrix user ids treated as principals (Parker/Eli).
    #[serde(default)]
    pub principals: Vec<String>,
    /// Identities allowed to carry sender_class=system (allowlist, exactly
    /// like principals — never derived from the sender string).
    #[serde(default)]
    pub system_senders: Vec<String>,
    /// Agent registry JSON (array of {handle, capabilities[], active}).
    /// Optional when tracker_db_path is set (the agents table is used).
    #[serde(default)]
    pub roster_path: Option<PathBuf>,
    /// Ingest spool dir: *.jsonl files of InboundMessage lines.
    #[serde(default)]
    pub ingest_dir: Option<PathBuf>,
    /// Delivery outbox dir (SpoolTransport).
    #[serde(default)]
    pub outbox_dir: Option<PathBuf>,
    #[serde(default = "default_reap_interval_secs")]
    pub reap_interval_secs: u64,
    #[serde(default = "default_digest_interval_secs")]
    pub digest_interval_secs: u64,
    #[serde(default = "default_digest_max_items")]
    pub digest_max_items: usize,
    #[serde(default = "default_lease_ms")]
    pub lease_ms: i64,
    #[serde(default = "default_wake_rate_per_sec")]
    pub wake_rate_per_sec: f64,
    #[serde(default = "default_wake_burst")]
    pub wake_burst: f64,
    /// Glitchtip DSN (optional; DP8). No DSN = error reporting disabled.
    #[serde(default)]
    pub glitchtip_dsn: Option<String>,
}

fn default_reap_interval_secs() -> u64 {
    30
}
fn default_digest_interval_secs() -> u64 {
    300
}
fn default_digest_max_items() -> usize {
    crate::digest::DEFAULT_MAX_ITEMS
}
fn default_lease_ms() -> i64 {
    crate::board::DEFAULT_LEASE_MS
}
fn default_wake_rate_per_sec() -> f64 {
    2.0
}
fn default_wake_burst() -> f64 {
    5.0
}

impl Config {
    pub fn load(path: &std::path::Path) -> Result<Config, String> {
        let raw =
            std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
        serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimal_config_parses_with_defaults() {
        let c: Config = serde_json::from_str(r#"{"db_path": "/tmp/board.db"}"#).unwrap();
        assert_eq!(c.reap_interval_secs, 30);
        assert_eq!(c.digest_max_items, crate::digest::DEFAULT_MAX_ITEMS);
        assert!(c.tracker_db_path.is_none());
        assert!(c.glitchtip_dsn.is_none());
    }

    #[test]
    fn typoed_key_fails_loudly() {
        let err = serde_json::from_str::<Config>(
            r#"{"db_path": "/tmp/board.db", "xreap_interval_secs": 10}"#,
        )
        .unwrap_err();
        assert!(err.to_string().contains("unknown field"), "{err}");
    }

    #[test]
    fn missing_db_path_fails_by_name() {
        let err = serde_json::from_str::<Config>(r#"{}"#).unwrap_err();
        assert!(err.to_string().contains("db_path"), "{err}");
    }

    #[test]
    fn schema_version_is_accepted() {
        let c: Config =
            serde_json::from_str(r#"{"schema_version": 1, "db_path": "/tmp/board.db"}"#).unwrap();
        assert_eq!(c.schema_version, Some(CONFIG_SCHEMA_VERSION));
    }
}
