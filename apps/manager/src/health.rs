//! `agent-manager healthcheck` — the gate the canary/rollback flow keys on.
//!
//! Checks (mapping to the FABLE-SPEC three asserts):
//!   1. manager alive: heartbeat file fresh AND the pid in it is running
//!      (covers "process alive under its supervisor");
//!   2. agent pane alive: heartbeat state is an allowed state and, when
//!      running, the recorded tmux pane id still exists with our ownership
//!      tag;
//!   3. manager's Matrix sync loop advancing: last successful /sync within
//!      --max-sync-age (the manager long-polls every <=30s, so a healthy
//!      manager updates this constantly).
//!
//! The spec's third assert — the AGENT answers a ping over Matrix — is NOT
//! implemented here: it needs a second Matrix identity to send the ping and
//! belongs to the deploy driver (see the runbook). This subcommand is
//! read-only and safe to run at any frequency.
//!
//! Exit code 0 = healthy; 1 = unhealthy (reasons on stdout); 2 = usage/config
//! error.

use crate::config::Config;
use crate::state::{epoch_secs, Heartbeat, HEARTBEAT_SCHEMA_VERSION};
use crate::tmux::Tmux;

pub struct HealthOpts {
    pub max_heartbeat_age: u64, // seconds
    pub max_sync_age: u64,      // seconds; 0 disables the sync check
    pub allow_states: Vec<String>,
    pub json: bool,
}

impl Default for HealthOpts {
    fn default() -> Self {
        HealthOpts {
            max_heartbeat_age: 30,
            max_sync_age: 120,
            allow_states: vec!["running".into()],
            json: false,
        }
    }
}

fn pid_alive(pid: u32) -> bool {
    // kill(pid, 0): 0 => exists; EPERM => exists but not ours.
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if r == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

pub fn run(cfg: &Config, opts: &HealthOpts) -> i32 {
    let mut failures: Vec<String> = Vec::new();
    let mut notes: Vec<String> = Vec::new();

    let hb: Option<Heartbeat> = std::fs::read_to_string(&cfg.heartbeat_path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());

    match &hb {
        None => failures.push(format!(
            "heartbeat missing/unreadable at {}",
            cfg.heartbeat_path.display()
        )),
        Some(hb) => {
            // Shape tolerance, not a gate: a legacy v1 file (`schema: 1`,
            // written by a pre-rename manager) still parses via the serde
            // alias — note it so the skew is visible during a deploy window.
            if hb.schema_version == 1 {
                notes.push("heartbeat is legacy v1 shape (`schema: 1`) — deprecated, expect schema_version 2".into());
            } else if hb.schema_version != HEARTBEAT_SCHEMA_VERSION {
                notes.push(format!(
                    "heartbeat schema_version {} (this binary expects {HEARTBEAT_SCHEMA_VERSION})",
                    hb.schema_version
                ));
            }
            let now = epoch_secs();
            let age = now.saturating_sub(hb.updated_at_epoch);
            if age > opts.max_heartbeat_age {
                failures.push(format!(
                    "heartbeat stale: {age}s old (max {})",
                    opts.max_heartbeat_age
                ));
            } else {
                notes.push(format!("heartbeat fresh ({age}s)"));
            }

            if pid_alive(hb.pid) {
                notes.push(format!("manager pid {} alive", hb.pid));
            } else {
                failures.push(format!("manager pid {} not running", hb.pid));
            }

            if opts.allow_states.iter().any(|s| s == &hb.state) {
                notes.push(format!("state {}", hb.state));
            } else {
                failures.push(format!(
                    "state {:?} not in allowed states {:?}",
                    hb.state, opts.allow_states
                ));
            }

            if hb.state == "running" {
                // tmux_session is nullable by contract (non-tmux platforms);
                // consumers must not require it — skip the pane assert then.
                match (&hb.tmux_session, &hb.pane_id) {
                    (None, _) => notes.push(
                        "no tmux_session in heartbeat (non-tmux platform) — pane check skipped"
                            .into(),
                    ),
                    (Some(ts), Some(p)) => {
                        let tmux = Tmux::new(ts, &cfg.pane_tag);
                        if tmux.pane_alive(p) {
                            notes.push(format!("agent pane {p} alive+tagged"));
                        } else {
                            failures.push(format!("agent pane {p} missing or untagged"));
                        }
                    }
                    (Some(_), None) => {
                        failures.push("state=running but heartbeat has no pane_id".into())
                    }
                }
            }

            if opts.max_sync_age > 0 {
                let sync_age = epoch_secs().saturating_sub(hb.last_sync_ok_epoch);
                if hb.last_sync_ok_epoch == 0 {
                    failures.push("matrix sync has never succeeded".into());
                } else if sync_age > opts.max_sync_age {
                    failures.push(format!(
                        "matrix sync stale: {sync_age}s old (max {})",
                        opts.max_sync_age
                    ));
                } else {
                    notes.push(format!("matrix sync fresh ({sync_age}s)"));
                }
            }
        }
    }

    let healthy = failures.is_empty();
    if opts.json {
        let out = serde_json::json!({
            "healthy": healthy,
            "failures": failures,
            "ok": notes,
            "heartbeat": hb,
        });
        println!("{}", serde_json::to_string_pretty(&out).unwrap());
    } else {
        for n in &notes {
            println!("ok: {n}");
        }
        for f in &failures {
            println!("FAIL: {f}");
        }
        println!("{}", if healthy { "HEALTHY" } else { "UNHEALTHY" });
    }
    if healthy {
        0
    } else {
        1
    }
}
