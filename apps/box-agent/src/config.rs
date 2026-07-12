//! Box-agent config — deny_unknown_fields (BA9).

use std::path::PathBuf;

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    #[serde(default)]
    pub schema_version: Option<u32>,
    /// This box-agent's canonical fleet handle (validated at boot).
    pub handle: String,
    /// Machine label in canonical form ('.N' for lab dot-hosts).
    #[serde(default)]
    pub host: Option<String>,
    /// Capability tags this box provides (needs ⊆ provides gate).
    #[serde(default)]
    pub provides: Vec<String>,
    /// Worker argv template: `{body}`/`{task_id}`/`{card_id}` placeholders.
    /// e.g. ["claude", "-p", "{body}"] in production, ["true"] in tests.
    pub worker_cmd: Vec<String>,
    #[serde(default = "default_max_workers")]
    pub max_workers: usize,
    /// The box-agent's own SQLite (envelope dedup `seen` table).
    pub db_path: PathBuf,
    /// Inbound envelope spool: <inbox_dir>/<handle>.outbox.jsonl written by
    /// the dispatcher/control-plane transports.
    pub inbox_dir: PathBuf,
    /// Outbound spool (capacity reports, task responses, fleet events ride
    /// the fleet_dir instead).
    pub outbox_dir: PathBuf,
    /// Where fleet-event snapshots are written (data/fleet layout). Absent =
    /// fleet events disabled.
    #[serde(default)]
    pub fleet_dir: Option<PathBuf>,
    #[serde(default = "default_capacity_interval_secs")]
    pub capacity_interval_secs: u64,
    #[serde(default)]
    pub glitchtip_dsn: Option<String>,
}

fn default_max_workers() -> usize {
    2
}
fn default_capacity_interval_secs() -> u64 {
    30
}

impl Config {
    pub fn load(path: &std::path::Path) -> Result<Config, String> {
        let raw =
            std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
        let cfg: Config =
            serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))?;
        if !dispatcher::card::is_canonical_handle(&cfg.handle) {
            return Err(format!("non-canonical handle {:?} in config", cfg.handle));
        }
        if cfg.worker_cmd.is_empty() {
            return Err("worker_cmd must not be empty".into());
        }
        Ok(cfg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &std::path::Path, body: &str) -> PathBuf {
        let p = dir.join("config.json");
        std::fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn minimal_config_loads() {
        let dir = tempfile::tempdir().unwrap();
        let p = write(
            dir.path(),
            r#"{"handle": "box-a", "worker_cmd": ["true"], "db_path": "/tmp/ba.db",
                "inbox_dir": "/tmp/in", "outbox_dir": "/tmp/out"}"#,
        );
        let c = Config::load(&p).unwrap();
        assert_eq!(c.max_workers, 2);
        assert_eq!(c.capacity_interval_secs, 30);
    }

    #[test]
    fn bad_handle_and_empty_cmd_fail_at_boot() {
        let dir = tempfile::tempdir().unwrap();
        let p = write(
            dir.path(),
            r#"{"handle": "Box A", "worker_cmd": ["true"], "db_path": "/tmp/ba.db",
                "inbox_dir": "/tmp/in", "outbox_dir": "/tmp/out"}"#,
        );
        assert!(Config::load(&p).unwrap_err().contains("non-canonical"));
        let p = write(
            dir.path(),
            r#"{"handle": "box-a", "worker_cmd": [], "db_path": "/tmp/ba.db",
                "inbox_dir": "/tmp/in", "outbox_dir": "/tmp/out"}"#,
        );
        assert!(Config::load(&p).unwrap_err().contains("worker_cmd"));
    }

    #[test]
    fn typo_fails_loudly() {
        let dir = tempfile::tempdir().unwrap();
        let p = write(
            dir.path(),
            r#"{"handle": "box-a", "worker_cmd": ["true"], "db_path": "/tmp/ba.db",
                "inbox_dir": "/tmp/in", "outbox_dir": "/tmp/out", "max_wokers": 3}"#,
        );
        assert!(Config::load(&p).unwrap_err().contains("unknown field"));
    }
}
