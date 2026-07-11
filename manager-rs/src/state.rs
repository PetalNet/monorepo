//! Durable session state + heartbeat file.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::Path;

fn default_true() -> bool {
    true
}

/// The session-state file. On-disk key is `sessionId` (camelCase) for
/// drop-in compatibility with the file the JS manager wrote — a rollback to
/// manager.js keeps working (it ignores the extra `bootstrapped` key).
///
/// `bootstrapped` restores the first-boot vs resume distinction the JS
/// manager lost (its two --resume branches were identical):
///   - freshly minted id  => bootstrapped=false => launch with `--session-id <id>`
///   - previously spawned => bootstrapped=true  => launch with `--resume <id>`
///
/// When the field is absent (legacy file written by manager.js) we default to
/// TRUE: that session has been running already, so resume is correct.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionState {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(default = "default_true")]
    pub bootstrapped: bool,
}

impl SessionState {
    pub fn fresh() -> SessionState {
        SessionState {
            session_id: uuid::Uuid::new_v4().to_string(),
            bootstrapped: false,
        }
    }

    /// JS parity (loadOrCreateSessionId): use the file if parseable, else
    /// mint a new id and persist it with mode 0600.
    pub fn load_or_create(path: &Path) -> SessionState {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(s) = serde_json::from_str::<SessionState>(&text) {
                return s;
            }
        }
        let s = SessionState::fresh();
        if let Err(e) = s.save(path) {
            // Non-fatal, same as JS (it would have thrown; we prefer to keep
            // supervising with an in-memory id and complain loudly).
            eprintln!("[manager] WARN: cannot persist session state to {}: {e}", path.display());
        }
        s
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        write_file_atomic(path, serde_json::to_string(self).unwrap().as_bytes(), Some(0o600))
    }
}

/// Current heartbeat contract version
/// (docs/contracts/schemas/session-state.schema.json#/$defs/heartbeat).
pub const HEARTBEAT_SCHEMA_VERSION: u32 = 2;

/// Status snapshot rewritten every supervisor tick; the `healthcheck`
/// subcommand (and the canary deploy driver) reads it.
///
/// v2 = the N0.1 contract: key renamed `schema`→`schema_version` (fleet
/// standard) plus optional `handle` and `channel_lock`. The `alias` keeps a
/// legacy v1 file (`schema: 1`) readable so a healthcheck binary deployed
/// ahead of the manager flip never hard-fails on shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Heartbeat {
    #[serde(alias = "schema")]
    pub schema_version: u32,
    pub version: String,
    /// Fleet handle of the supervised agent (lowercase); optional in v2.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    pub pid: u32,
    pub state: String,
    pub session_id: String,
    /// Nullable by contract: non-tmux platforms (Windows box agents) have
    /// none, and consumers must not require it.
    pub tmux_session: Option<String>,
    pub pane_id: Option<String>,
    /// false = we own/monitor a pane but won't inject keys into it
    pub io_ok: bool,
    pub crash_count: u32,
    /// epoch seconds; 0 = never
    pub started_at_epoch: u64,
    pub last_sync_ok_epoch: u64,
    pub updated_at_epoch: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_lock: Option<ChannelLock>,
}

/// Single-owner Matrix channel-lock state ($defs/channelLock). Exactly one
/// process may speak as the agent on its channel; `lockout` means another
/// owner was detected and this process must stand down.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelLock {
    pub state: ChannelLockState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    /// epoch seconds; 0 = unknown
    #[serde(default)]
    pub acquired_at_epoch: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contender: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChannelLockState {
    Held,
    Released,
    Lockout,
}

impl ChannelLock {
    /// STUB until N1.3/N2.2 wires the real matrix-channel lock through:
    /// today's single-manager deploy always holds its channel, and 0 means
    /// "acquired-at unknown" (DECISIONS-N1.1.md N3).
    pub fn stub_held() -> ChannelLock {
        ChannelLock {
            state: ChannelLockState::Held,
            owner: None,
            acquired_at_epoch: 0,
            contender: None,
        }
    }
}

pub fn write_file_atomic(path: &Path, contents: &[u8], mode: Option<u32>) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp-write");
    {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        if let Some(m) = mode {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(m);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(contents)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

pub fn epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v2_heartbeat() -> Heartbeat {
        Heartbeat {
            schema_version: HEARTBEAT_SCHEMA_VERSION,
            version: "0.1.0".into(),
            handle: Some("janet".into()),
            pid: 4242,
            state: "running".into(),
            tmux_session: Some("janet-claude".into()),
            pane_id: Some("%7".into()),
            session_id: "b8e7d3a2-0000-4000-8000-000000000000".into(),
            io_ok: true,
            crash_count: 0,
            started_at_epoch: 1_700_000_000,
            last_sync_ok_epoch: 1_700_000_100,
            updated_at_epoch: 1_700_000_101,
            channel_lock: Some(ChannelLock::stub_held()),
        }
    }

    #[test]
    fn heartbeat_v2_serializes_contract_shape() {
        let v = serde_json::to_value(v2_heartbeat()).unwrap();
        let obj = v.as_object().unwrap();
        assert_eq!(v["schema_version"], 2);
        assert!(!obj.contains_key("schema"), "v1 key must not be written");
        assert_eq!(v["handle"], "janet");
        assert_eq!(v["channel_lock"]["state"], "held");
        assert_eq!(v["channel_lock"]["acquired_at_epoch"], 0);
        // Optional-absent fields are omitted, not null (additionalProperties
        // is false in the contract; omit-when-absent is the conforming shape).
        assert!(!v["channel_lock"].as_object().unwrap().contains_key("owner"));
        assert!(!v["channel_lock"].as_object().unwrap().contains_key("contender"));
    }

    #[test]
    fn heartbeat_v2_round_trips() {
        let hb = v2_heartbeat();
        let back: Heartbeat =
            serde_json::from_str(&serde_json::to_string(&hb).unwrap()).unwrap();
        assert_eq!(back.schema_version, 2);
        assert_eq!(back.handle.as_deref(), Some("janet"));
        assert_eq!(back.channel_lock, Some(ChannelLock::stub_held()));
    }

    #[test]
    fn heartbeat_reads_legacy_v1_file() {
        // Exactly what the deployed pre-rename manager writes.
        let v1 = r#"{
            "schema": 1, "version": "0.1.0", "pid": 4242, "state": "running",
            "session_id": "b8e7d3a2-0000-4000-8000-000000000000",
            "tmux_session": "janet-claude", "pane_id": "%7", "io_ok": true,
            "crash_count": 0, "started_at_epoch": 1700000000,
            "last_sync_ok_epoch": 1700000100, "updated_at_epoch": 1700000101
        }"#;
        let hb: Heartbeat = serde_json::from_str(v1).unwrap();
        assert_eq!(hb.schema_version, 1);
        assert_eq!(hb.handle, None);
        assert_eq!(hb.channel_lock, None);
        assert_eq!(hb.tmux_session.as_deref(), Some("janet-claude"));
    }

    #[test]
    fn heartbeat_tolerates_null_tmux_fields() {
        // OS-neutral contract: a Windows manager writes nulls here.
        let mut v = serde_json::to_value(v2_heartbeat()).unwrap();
        v["tmux_session"] = serde_json::Value::Null;
        v["pane_id"] = serde_json::Value::Null;
        let hb: Heartbeat = serde_json::from_value(v).unwrap();
        assert_eq!(hb.tmux_session, None);
        assert_eq!(hb.pane_id, None);
    }
}
