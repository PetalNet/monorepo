//! Configuration loading.
//!
//! Publish-agnostic: nothing host-specific (paths, hostnames, room ids,
//! account names) is compiled into the binary. Everything arrives from a JSON
//! config file whose path is given by the `AGENT_MANAGER_CONFIG` env var,
//! plus an optional work-dir CLI argument (parity with `node manager.js
//! [work-dir]`). See `config.example.json` and the runbook appendix for the
//! schema.

use serde::Deserialize;
use std::path::{Path, PathBuf};

pub const CONFIG_ENV: &str = "AGENT_MANAGER_CONFIG";

/// Raw on-disk schema. `deny_unknown_fields` so a typo'd key fails loudly at
/// boot instead of silently falling back to a default (this process is
/// harness-critical; misconfiguration must be visible).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    // ── required ──────────────────────────────────────────────────────────
    /// Matrix credentials JSON: { homeserver, access_token, user_id, ... }.
    /// (Same file the JS manager read: e.g. ~/.claude/shared/janet-account.json)
    creds_path: String,
    /// Matrix room ID the manager reports to and takes !commands from.
    control_room: String,

    // ── optional ──────────────────────────────────────────────────────────
    /// Display name used in manager status messages (e.g. "janet").
    agent_name: Option<String>,
    /// Directory the agent session starts in. CLI arg overrides this.
    work_dir: Option<String>,
    /// Session-state JSON ({"sessionId": ..., "bootstrapped": ...}).
    state_path: Option<String>,
    /// Rate-limit hook drop file ({"resetAt": ...}), written by a Claude hook.
    rate_limit_hook_path: Option<String>,
    /// Optional model-override file; non-empty contents => `--model <contents>`.
    model_override_path: Option<String>,
    /// File the in-tmux shell writes the agent's exit code to.
    exit_code_path: Option<String>,
    /// Heartbeat/status JSON the manager rewrites every tick (healthcheck input).
    heartbeat_path: Option<String>,
    /// Claude session-lock directory (stale locks for our session id get removed).
    sessions_dir: Option<String>,
    /// tmux session name the agent pane lives in.
    tmux_session: Option<String>,
    /// Value of the @agent_manager_owner pane option that marks OUR pane.
    pane_tag: Option<String>,
    /// Claude Code binary (name or absolute path).
    claude_bin: Option<String>,
    /// Full argument list for the agent process (lab-specific flags live HERE,
    /// not in code). --model/--resume/--session-id are appended by the manager.
    claude_args: Option<Vec<String>>,
    /// Prepended to PATH inside the tmux shell (e.g. "~/.local/bin").
    path_prepend: Option<String>,
    /// Kill the agent pane on manager shutdown (JS-manager parity: true).
    /// false = leave the agent running and re-adopt on next manager boot,
    /// which allows blipless manager deploys (less battle-tested path).
    kill_agent_on_shutdown: Option<bool>,
    /// Size of a freshly created detached tmux session.
    tmux_width: Option<u32>,
    tmux_height: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub creds_path: PathBuf,
    pub control_room: String,
    pub agent_name: String,
    pub work_dir: PathBuf,
    pub state_path: PathBuf,
    pub rate_limit_hook_path: PathBuf,
    pub model_override_path: Option<PathBuf>,
    pub exit_code_path: PathBuf,
    pub heartbeat_path: PathBuf,
    pub sessions_dir: PathBuf,
    pub tmux_session: String,
    pub pane_tag: String,
    pub claude_bin: String,
    pub claude_args: Vec<String>,
    pub path_prepend: String,
    pub kill_agent_on_shutdown: bool,
    pub tmux_width: u32,
    pub tmux_height: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MatrixCreds {
    pub homeserver: String,
    pub access_token: String,
    pub user_id: String,
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not set".to_string())
}

fn expand(home: &Path, s: &str) -> PathBuf {
    if s == "~" {
        home.to_path_buf()
    } else if let Some(rest) = s.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(s)
    }
}

impl Config {
    /// Load config from $AGENT_MANAGER_CONFIG. `work_dir_arg` (CLI) wins over
    /// the config file's work_dir, which wins over $HOME (JS parity:
    /// `process.argv[2] || os.homedir()`).
    pub fn load(work_dir_arg: Option<&str>) -> Result<Config, String> {
        let cfg_path = std::env::var(CONFIG_ENV)
            .map_err(|_| format!("{CONFIG_ENV} is not set (must point at the manager config JSON)"))?;
        let text = std::fs::read_to_string(&cfg_path)
            .map_err(|e| format!("cannot read config {cfg_path}: {e}"))?;
        let raw: RawConfig = serde_json::from_str(&text)
            .map_err(|e| format!("bad config {cfg_path}: {e}"))?;
        let home = home_dir()?;

        let shared = |name: &str| home.join(".claude/shared").join(name);

        let work_dir = match work_dir_arg {
            Some(w) => expand(&home, w),
            None => raw
                .work_dir
                .as_deref()
                .map(|w| expand(&home, w))
                .unwrap_or_else(|| home.clone()),
        };

        Ok(Config {
            creds_path: expand(&home, &raw.creds_path),
            control_room: raw.control_room,
            agent_name: raw.agent_name.unwrap_or_else(|| "agent".into()),
            work_dir,
            state_path: raw
                .state_path
                .map(|p| expand(&home, &p))
                .unwrap_or_else(|| shared("agent-session-state.json")),
            rate_limit_hook_path: raw
                .rate_limit_hook_path
                .map(|p| expand(&home, &p))
                .unwrap_or_else(|| shared("agent-rate-limit.json")),
            model_override_path: raw.model_override_path.map(|p| expand(&home, &p)),
            exit_code_path: raw
                .exit_code_path
                .map(|p| expand(&home, &p))
                .unwrap_or_else(|| shared("agent-exit-code")),
            heartbeat_path: raw
                .heartbeat_path
                .map(|p| expand(&home, &p))
                .unwrap_or_else(|| shared("agent-manager-heartbeat.json")),
            sessions_dir: raw
                .sessions_dir
                .map(|p| expand(&home, &p))
                .unwrap_or_else(|| home.join(".claude/sessions")),
            tmux_session: raw.tmux_session.unwrap_or_else(|| "agent-claude".into()),
            pane_tag: raw.pane_tag.unwrap_or_else(|| "agent-manager".into()),
            claude_bin: raw.claude_bin.unwrap_or_else(|| "claude".into()),
            claude_args: raw
                .claude_args
                .unwrap_or_else(|| vec!["--dangerously-skip-permissions".into()]),
            path_prepend: raw
                .path_prepend
                .map(|p| expand(&home, &p).to_string_lossy().into_owned())
                .unwrap_or_else(|| home.join(".local/bin").to_string_lossy().into_owned()),
            kill_agent_on_shutdown: raw.kill_agent_on_shutdown.unwrap_or(true),
            tmux_width: raw.tmux_width.unwrap_or(220),
            tmux_height: raw.tmux_height.unwrap_or(50),
        })
    }

    pub fn load_creds(&self) -> Result<MatrixCreds, String> {
        let text = std::fs::read_to_string(&self.creds_path)
            .map_err(|e| format!("cannot read creds {}: {e}", self.creds_path.display()))?;
        serde_json::from_str(&text)
            .map_err(|e| format!("bad creds {}: {e}", self.creds_path.display()))
    }
}
