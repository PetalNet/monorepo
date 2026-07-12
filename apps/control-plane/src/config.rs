//! Control-plane config — deny_unknown_fields (CP12).

use std::path::PathBuf;

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    #[serde(default)]
    pub schema_version: Option<u32>,
    /// Registry DB (control-plane-owned SQLite).
    pub db_path: PathBuf,
    /// Credential vault directory (0700; files 0600).
    pub vault_dir: PathBuf,
    /// Tracker DB for the discipline pass's REAL lease lookups (a fleet
    /// event's task_id is not lease state). Absent = discipline disabled.
    /// Points at temp/disposable DBs during dev — never the live tracker.
    #[serde(default)]
    pub tracker_db_path: Option<PathBuf>,
    /// Inbound envelope spool dir (agent.capacity, usage.report, …).
    #[serde(default)]
    pub ingest_dir: Option<PathBuf>,
    /// Outbound spool dir (governance.action, discipline nags → dispatcher).
    #[serde(default)]
    pub outbox_dir: Option<PathBuf>,
    /// Fleet-wide token pool per governance window.
    #[serde(default = "default_pool_tokens")]
    pub pool_tokens: u64,
    /// Default budget grant per agent (lease from the pool).
    #[serde(default = "default_grant_tokens")]
    pub default_grant_tokens: u64,
    #[serde(default = "default_grant_lease_secs")]
    pub grant_lease_secs: i64,
    /// Governance evaluation interval.
    #[serde(default = "default_governance_interval_secs")]
    pub governance_interval_secs: u64,
    /// Tracker discipline grace (secs in `working` without a lease).
    #[serde(default = "default_discipline_grace_secs")]
    pub discipline_grace_secs: i64,
    /// Fleet-events dir to watch for discipline checks (the cockpit's
    /// data/fleet/<handle>.json layout — pointed at a COPY or test dir, never
    /// required to be the live one).
    #[serde(default)]
    pub fleet_events_dir: Option<PathBuf>,
    #[serde(default)]
    pub glitchtip_dsn: Option<String>,
}

fn default_pool_tokens() -> u64 {
    5_000_000
}
fn default_grant_tokens() -> u64 {
    500_000
}
fn default_grant_lease_secs() -> i64 {
    3600
}
fn default_governance_interval_secs() -> u64 {
    30
}
fn default_discipline_grace_secs() -> i64 {
    600
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
    fn minimal_parses_with_defaults() {
        let c: Config =
            serde_json::from_str(r#"{"db_path": "/tmp/cp.db", "vault_dir": "/tmp/vault"}"#)
                .unwrap();
        assert_eq!(c.pool_tokens, 5_000_000);
        assert_eq!(c.discipline_grace_secs, 600);
    }

    #[test]
    fn typo_fails_loudly() {
        let err = serde_json::from_str::<Config>(
            r#"{"db_path": "/tmp/cp.db", "vault_dir": "/tmp/v", "pool_tokenz": 5}"#,
        )
        .unwrap_err();
        assert!(err.to_string().contains("unknown field"), "{err}");
    }

    #[test]
    fn required_keys_fail_by_name() {
        let err = serde_json::from_str::<Config>(r#"{"db_path": "/tmp/cp.db"}"#).unwrap_err();
        assert!(err.to_string().contains("vault_dir"), "{err}");
    }
}
