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

/// Status snapshot rewritten every supervisor tick; the `healthcheck`
/// subcommand (and the canary deploy driver) reads it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Heartbeat {
    pub schema: u32,
    pub version: String,
    pub pid: u32,
    pub state: String,
    pub session_id: String,
    pub tmux_session: String,
    pub pane_id: Option<String>,
    /// false = we own/monitor a pane but won't inject keys into it
    pub io_ok: bool,
    pub crash_count: u32,
    /// epoch seconds; 0 = never
    pub started_at_epoch: u64,
    pub last_sync_ok_epoch: u64,
    pub updated_at_epoch: u64,
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
