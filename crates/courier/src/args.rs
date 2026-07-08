//! CLI flags and environment variables.
//!
//! Env names (`MATRIX_*`) and defaults are wire-compatible with the previous
//! generation, so an existing `.env` / compose file drops in unchanged.

use std::path::PathBuf;

use clap::Parser;

use crate::service::SERVICE_NAME;

/// Matrix relay bot with E2EE, plugins, and a reliability-first core.
#[derive(Parser, Debug)]
#[command(name = SERVICE_NAME, version, about)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "CLI flags are naturally boolean"
)]
pub struct Args {
    /// Homeserver base URL, e.g. `https://matrix-client.matrix.org`.
    #[arg(long, env = "MATRIX_HOMESERVER")]
    pub homeserver: String,

    /// Username (localpart or full user ID)
    #[arg(long, env = "MATRIX_USERNAME")]
    pub username: String,

    /// Password (if omitted, will prompt if needed)
    #[arg(long, env = "MATRIX_PASSWORD")]
    pub password: Option<String>,

    /// Directory for persistent state (encryption keys, sync cache)
    #[arg(long, env = "MATRIX_STORE", default_value = "./bot-store")]
    pub store: PathBuf,

    /// JSON session file for access token/device info
    #[arg(long, env = "MATRIX_SESSION_FILE", default_value = "./session.json")]
    pub session_file: PathBuf,

    /// Device display name
    #[arg(long, env = "MATRIX_DEVICE_NAME", default_value = SERVICE_NAME)]
    pub device_name: String,

    /// Path to YAML config describing room clusters to relay between
    #[arg(long, env = "MATRIX_CONFIG", default_value = "./config.yaml")]
    pub config: PathBuf,

    /// Disable auto-joining rooms when invited
    #[arg(long)]
    pub no_autojoin: bool,

    /// Auto-accept and confirm SAS verifications (insecure for production)
    #[arg(long, env = "MATRIX_AUTO_VERIFY", default_value_t = true)]
    pub auto_verify: bool,

    /// Sync long-poll timeout in milliseconds
    #[arg(long, env = "MATRIX_SYNC_TIMEOUT_MS", default_value_t = 30000)]
    pub sync_timeout_ms: u64,

    /// DEPRECATED and ignored. A per-iteration sync timeout silently skips
    /// events: matrix-sdk persists the sync token before event handlers run,
    /// so cancelling an iteration mid-processing loses messages. The
    /// OS-thread watchdog (`--watchdog-secs`) covers genuine stalls instead.
    /// Kept only so existing env files don't break argument parsing.
    #[arg(
        long,
        env = "MATRIX_SYNC_ITERATION_TIMEOUT_SECS",
        default_value_t = 180
    )]
    pub sync_iteration_timeout_secs: u64,

    /// Liveness watchdog: exit (for the container to restart us) if the sync
    /// loop makes no progress for this many seconds. 0 disables the watchdog.
    #[arg(long, env = "MATRIX_WATCHDOG_SECS", default_value_t = 300)]
    pub watchdog_secs: u64,

    /// Interval in seconds between periodic relay-leg health log reports.
    #[arg(long, env = "MATRIX_HEALTH_REPORT_SECS", default_value_t = 900)]
    pub health_report_secs: u64,

    /// Parse and print the config, then exit without connecting.
    #[arg(long)]
    pub check_config: bool,

    /// Enable dev-mode behaviors (must also be enabled in config)
    #[arg(short = 'd', long = "dev")]
    pub dev: bool,

    /// Instance mode override via env/flag: "dev" or "prod"
    #[arg(long, env = "MATRIX_MODE")]
    pub mode: Option<String>,

    /// Run as an internal MCP server (e.g. "time") instead of the bot
    #[arg(long)]
    pub mcp_server: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_parse_with_minimal_flags() {
        let args = Args::try_parse_from([
            SERVICE_NAME,
            "--homeserver",
            "https://hs.example",
            "--username",
            "bot",
        ])
        .expect("minimal args parse");
        assert_eq!(args.device_name, SERVICE_NAME);
        assert_eq!(args.sync_timeout_ms, 30000);
        assert_eq!(args.watchdog_secs, 300);
        assert!(args.auto_verify);
    }

    #[test]
    fn deprecated_iteration_timeout_still_parses() {
        let args = Args::try_parse_from([
            SERVICE_NAME,
            "--homeserver",
            "https://hs.example",
            "--username",
            "bot",
            "--sync-iteration-timeout-secs",
            "60",
        ])
        .expect("deprecated flag accepted");
        assert_eq!(args.sync_iteration_timeout_secs, 60);
    }
}
