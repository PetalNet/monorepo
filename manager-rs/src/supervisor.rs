//! The supervision state machine — a faithful port of manager.js's
//! startClaude / attachTmuxExitPoll / handleExit / commandLoop, restructured
//! as one single-threaded tick loop (1s tick; pane liveness every 5s, JS
//! parity). All Matrix I/O goes through channels so this loop can never be
//! stalled by the network: the manager keeps respawning the agent even with
//! the homeserver down.
//!
//! Deliberate deltas from manager.js (each flagged in the port notes):
//!  * pane-id + user-option ownership instead of session-name / pane-0.0
//!    targeting (hard requirement; see tmux.rs header);
//!  * liveness = "our tagged pane exists", not "tmux session exists" —
//!    manager.js could NOT detect the agent dying while humans kept other
//!    panes open in the session;
//!  * respawn into a new window / kill only our pane, so human panes in the
//!    shared session survive stop/restart;
//!  * first boot of a fresh session id uses `--session-id <id>`, subsequent
//!    boots use `--resume <id>` (manager.js's two branches had both decayed
//!    to --resume);
//!  * spawn failures (tmux itself erroring) enter the same crash-backoff
//!    path instead of being assumed to succeed.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, TryRecvError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{DateTime, Local, Utc};

use crate::config::Config;
use crate::state::{epoch_secs, write_file_atomic, Heartbeat, SessionState};
use crate::tmux::Tmux;

const TICK: Duration = Duration::from_secs(1);
const LIVENESS_EVERY: Duration = Duration::from_secs(5); // JS: 5s poll
const QUICK_CRASH: Duration = Duration::from_secs(60); // JS QUICK_CRASH_MS
const BACKOFF_START: Duration = Duration::from_secs(5);
const BACKOFF_CAP: Duration = Duration::from_secs(30 * 60);
const MAX_CRASHES: u32 = 10;
const RATE_LIMIT_GRACE: Duration = Duration::from_secs(15);

/// Slash-command passthrough allowlist (JS parity). Safe, non-mutating
/// commands only. NEVER add /model, /config, /fast — they hang the agent's
/// own session (memory: janet-model-swap-footgun). manager.js also carried a
/// denylist regex, but it was redundant: anything not on this allowlist is
/// refused with the same message.
const SLASH_ALLOW: &[&str] = &["/compact", "/context", "/cost", "/status"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentState {
    Starting,
    Running,
    RateLimited,
    Waiting,
    Crashed,
    Stopped,
}

impl AgentState {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentState::Starting => "starting",
            AgentState::Running => "running",
            AgentState::RateLimited => "rate_limited",
            AgentState::Waiting => "waiting",
            AgentState::Crashed => "crashed",
            AgentState::Stopped => "stopped",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResumeKind {
    RateLimit,
    Crash,
}

struct PendingResume {
    at: Instant,
    kind: ResumeKind,
}

pub struct Supervisor {
    cfg: Config,
    tmux: Tmux,
    session: SessionState,
    state: AgentState,
    /// Some(pane_id) == "we own a live agent pane" (JS `claudeProc`).
    pane_id: Option<String>,
    crash_count: u32,
    crash_backoff: Duration,
    started_at: Option<Instant>,
    /// JS lastOutputAt: set at manager boot and reset on spawn/adopt. (It was
    /// never updated on actual output in manager.js either — the status
    /// line's "last output" has always meant "time since spawn/adopt".)
    last_output_at: Instant,
    rate_limit_reset: Option<DateTime<Utc>>,
    pending_resume: Option<PendingResume>,
    shutdown: Arc<AtomicBool>,
    sigterm: Arc<AtomicBool>,
    matrix_tx: Sender<String>,
    cmd_rx: Receiver<String>,
    last_sync_ok: Arc<AtomicU64>,
    last_liveness: Instant,
}

/// Minimal POSIX-shell single-quoting.
fn shq(s: &str) -> String {
    let plain = !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "/._-:@%+=,".contains(c));
    if plain {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

impl Supervisor {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        cfg: Config,
        session: SessionState,
        shutdown: Arc<AtomicBool>,
        sigterm: Arc<AtomicBool>,
        matrix_tx: Sender<String>,
        cmd_rx: Receiver<String>,
        last_sync_ok: Arc<AtomicU64>,
    ) -> Supervisor {
        let tmux = Tmux::new(&cfg.tmux_session, &cfg.pane_tag);
        Supervisor {
            cfg,
            tmux,
            session,
            state: AgentState::Stopped,
            pane_id: None,
            crash_count: 0,
            crash_backoff: BACKOFF_START,
            started_at: None,
            last_output_at: Instant::now(),
            rate_limit_reset: None,
            pending_resume: None,
            shutdown,
            sigterm,
            matrix_tx,
            cmd_rx,
            last_sync_ok,
            last_liveness: Instant::now(),
        }
    }

    fn log(&self, msg: &str) {
        println!("[manager] {msg}");
    }

    fn set_state(&mut self, s: AgentState) {
        self.state = s;
        self.log(&format!("→ {}", s.as_str()));
    }

    fn send(&self, text: String) {
        // Never blocks; sender thread has its own timeouts.
        let _ = self.matrix_tx.send(text);
    }

    // ── main loop ─────────────────────────────────────────────────────────

    pub fn run(mut self) {
        self.start_claude(); // JS parity: boot goes straight into a start

        while !self.shutdown.load(Ordering::SeqCst) {
            self.drain_commands();
            self.check_pending_resume();
            if self.pane_id.is_some() && self.last_liveness.elapsed() >= LIVENESS_EVERY {
                self.last_liveness = Instant::now();
                self.poll_liveness();
            }
            self.write_heartbeat();
            std::thread::sleep(TICK);
        }

        let reason = if self.sigterm.load(Ordering::SeqCst) { "SIGTERM" } else { "SIGINT" };
        self.graceful_shutdown(reason);
    }

    fn graceful_shutdown(&mut self, reason: &str) {
        self.pending_resume = None;
        self.log(&format!("shutting down ({reason})"));
        self.set_state(AgentState::Stopped);
        if let Some(p) = self.pane_id.take() {
            if self.cfg.kill_agent_on_shutdown {
                self.tmux.kill_pane(&p);
            } else {
                self.log(&format!(
                    "leaving agent pane {p} running (kill_agent_on_shutdown=false); next manager boot will adopt it"
                ));
            }
        }
        self.send(format!("{} manager stopped ({reason})", self.cfg.agent_name));
        self.write_heartbeat();
        // matrix_tx is dropped when `self` drops; main joins the sender
        // thread, which flushes the queue (bounded by per-send timeouts).
    }

    // ── spawn / adopt ─────────────────────────────────────────────────────

    fn start_claude(&mut self) {
        // Adopt path (JS parity): our tagged pane is already alive — the
        // manager restarted while the agent kept running. Take ownership,
        // don't respawn.
        if let Some(p) = self.tmux.find_tagged_pane() {
            if self.pane_id.is_none() {
                self.log(&format!("adopting existing tagged pane {p}"));
                self.pane_id = Some(p);
                self.started_at = Some(Instant::now());
                self.last_output_at = Instant::now();
                self.set_state(AgentState::Running);
            }
            return;
        }

        self.set_state(AgentState::Starting);

        // Clean up stale exit-code file (JS parity).
        let _ = std::fs::remove_file(&self.cfg.exit_code_path);
        self.clean_stale_session_locks();

        // Build the agent command line. Lab-specific flags come from config.
        let mut args: Vec<String> = self.cfg.claude_args.clone();
        if let Some(mp) = &self.cfg.model_override_path {
            if let Ok(m) = std::fs::read_to_string(mp) {
                let m = m.trim();
                if !m.is_empty() {
                    self.log(&format!("model override -> {m}"));
                    args.push("--model".into());
                    args.push(m.to_string());
                }
            }
        }
        // First-boot vs resume distinction (see state.rs).
        if self.session.bootstrapped {
            args.push("--resume".into());
        } else {
            args.push("--session-id".into());
        }
        args.push(self.session.session_id.clone());

        let arg_str = args.iter().map(|a| shq(a)).collect::<Vec<_>>().join(" ");
        // The trailing `echo $? > file` lets the exit poll read how the agent
        // died (informational; rate-limit detection uses the hook file).
        let cmd = format!(
            "cd {} && PATH={}:\"$PATH\" {} {}; echo $? > {}",
            shq(&self.cfg.work_dir.to_string_lossy()),
            shq(&self.cfg.path_prepend),
            shq(&self.cfg.claude_bin),
            arg_str,
            shq(&self.cfg.exit_code_path.to_string_lossy()),
        );
        self.log(&format!("tmux spawn: {cmd}"));

        let spawned = if self.tmux.session_alive() {
            // Humans (or leftovers) hold the session: never kill it — add our
            // own window. If somehow a stale tagged pane exists here, the
            // find_tagged_pane() above would have adopted it, so there is
            // none to clean up.
            let untagged = self.tmux.panes().len();
            if untagged > 0 {
                self.log(&format!(
                    "session '{}' already exists with {untagged} pane(s) (none ours) — spawning agent in a new window",
                    self.cfg.tmux_session
                ));
            }
            self.tmux.new_window_with_cmd(&cmd)
        } else {
            self.tmux
                .new_session_with_cmd(&cmd, self.cfg.tmux_width, self.cfg.tmux_height)
        };

        let pane = match spawned {
            Ok(p) => p,
            Err(e) => {
                // manager.js assumed tmux spawn always worked and let the 5s
                // poll discover the corpse; we route the failure straight
                // into the same crash-backoff path so we can never hot-loop.
                // started_at is cleared so this counts as a quick crash —
                // otherwise a long previous uptime would keep resetting the
                // crash counter and a permanently-broken tmux would retry
                // (and message Matrix) every 5s forever.
                self.log(&format!("SPAWN FAILED: {e}"));
                self.send(format!("agent spawn failed: {e}"));
                self.started_at = None;
                self.handle_exit(1);
                return;
            }
        };

        if !self.tmux.tag_pane(&pane) {
            // Without the tag we cannot prove ownership later; treat as a
            // failed spawn (kill what we just started so it can't leak).
            self.log(&format!("FAILED to tag pane {pane}; killing it and backing off"));
            self.tmux.kill_pane(&pane);
            self.send("agent spawn failed: could not tag pane (tmux >= 3.0 required)".into());
            self.started_at = None;
            self.handle_exit(1);
            return;
        }

        if !self.session.bootstrapped {
            self.session.bootstrapped = true;
            if let Err(e) = self.session.save(&self.cfg.state_path) {
                self.log(&format!("WARN: cannot persist session state: {e}"));
            }
        }

        self.pane_id = Some(pane.clone());
        self.started_at = Some(Instant::now());
        self.last_output_at = Instant::now();
        self.set_state(AgentState::Running);

        // Auto-accept startup prompts, off-thread (JS parity: async IIFE).
        // Pane-id targeting makes a stale accepter harmless: if the pane
        // dies, capture/send hit a missing id and the thread exits.
        let tmux = self.tmux.clone();
        let shutdown = Arc::clone(&self.shutdown);
        std::thread::Builder::new()
            .name("auto-accept".into())
            .spawn(move || auto_accept_prompts(tmux, pane, shutdown))
            .ok();
    }

    /// JS parity: remove any Claude session lock naming our session id so
    /// reuse doesn't fail with "already in use".
    fn clean_stale_session_locks(&self) {
        let Ok(entries) = std::fs::read_dir(&self.cfg.sessions_dir) else { return };
        for entry in entries.flatten() {
            let p = entry.path();
            let Ok(text) = std::fs::read_to_string(&p) else { continue };
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
            if v.get("sessionId").and_then(|s| s.as_str()) == Some(self.session.session_id.as_str())
            {
                let _ = std::fs::remove_file(&p);
            }
        }
    }

    // ── liveness / exit ───────────────────────────────────────────────────

    fn poll_liveness(&mut self) {
        let Some(pane) = self.pane_id.clone() else { return };
        if self.tmux.pane_alive(&pane) {
            return;
        }
        self.pane_id = None;
        let code = std::fs::read_to_string(&self.cfg.exit_code_path)
            .ok()
            .and_then(|s| s.trim().parse::<i32>().ok())
            .unwrap_or(1);
        self.log(&format!("agent pane {pane} ended, exit code={code}"));
        self.check_rate_limit_hook_file();
        self.handle_exit(code);
    }

    /// JS parity (checkRateLimitHookFile): consume the hook drop file. The
    /// hook writes {"resetAt": <string>}; accept RFC3339, epoch seconds, or
    /// epoch milliseconds (as string or number) — manager.js's `new
    /// Date(resetAt)` silently produced Invalid Date for numeric strings, we
    /// prefer to parse defensively. Unparseable => treated as plain crash.
    fn check_rate_limit_hook_file(&mut self) {
        let path = &self.cfg.rate_limit_hook_path;
        let Ok(text) = std::fs::read_to_string(path) else { return };
        let _ = std::fs::remove_file(path);
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return };
        let Some(raw) = v.get("resetAt") else { return };
        let parsed: Option<DateTime<Utc>> = match raw {
            serde_json::Value::String(s) => {
                let s = s.trim();
                DateTime::parse_from_rfc3339(s)
                    .map(|d| d.with_timezone(&Utc))
                    .ok()
                    .or_else(|| s.parse::<i64>().ok().and_then(epoch_to_utc))
            }
            serde_json::Value::Number(n) => n.as_i64().and_then(epoch_to_utc),
            _ => None,
        };
        match parsed {
            Some(reset) => {
                self.rate_limit_reset = Some(reset);
                self.log(&format!("rate limit from hook — reset at {}", reset.to_rfc3339()));
            }
            None => self.log(&format!("WARN: unparseable resetAt in {}: {text:?}", path.display())),
        }
    }

    /// JS handleExit. `code` is informational only (parity).
    fn handle_exit(&mut self, _code: i32) {
        // Intentional stop: stay stopped. (JS also checked SIGTERM/SIGINT
        // here; those route through graceful_shutdown in this port.) Clear
        // any rate-limit reset the hook file dropped during the stop —
        // manager.js let it leak and mis-schedule the NEXT crash recovery.
        if self.state == AgentState::Stopped {
            self.rate_limit_reset = None;
            return;
        }

        if let Some(reset) = self.rate_limit_reset.take() {
            self.set_state(AgentState::RateLimited);
            let until_ms = reset.timestamp_millis() - Utc::now().timestamp_millis();
            let wait = Duration::from_millis(until_ms.max(60_000) as u64);
            let wait_min = (wait.as_secs() + 30) / 60;
            let local = reset.with_timezone(&Local).format("%H:%M:%S");
            self.log(&format!("rate limit — waiting {wait_min}m"));
            self.send(format!("rate limited — resuming at {local} ({wait_min} min)"));
            self.crash_count = 0;
            self.crash_backoff = BACKOFF_START;
            self.set_state(AgentState::Waiting);
            self.pending_resume = Some(PendingResume {
                at: Instant::now() + wait + RATE_LIMIT_GRACE,
                kind: ResumeKind::RateLimit,
            });
            return;
        }

        // Crash. Long-lived sessions reset the backoff (JS parity).
        let uptime = self.started_at.map(|t| t.elapsed()).unwrap_or_default();
        if uptime > QUICK_CRASH {
            self.crash_count = 0;
            self.crash_backoff = BACKOFF_START;
        }
        self.crash_count += 1;
        if self.crash_count > MAX_CRASHES {
            self.set_state(AgentState::Stopped);
            self.send(format!(
                "stopped after {} crashes — send 'start' to retry",
                self.crash_count
            ));
            return;
        }

        let delay = self.crash_backoff.min(BACKOFF_CAP);
        self.crash_backoff = (self.crash_backoff * 2).min(BACKOFF_CAP);
        self.log(&format!(
            "crash #{} — retry in {}s",
            self.crash_count,
            delay.as_secs()
        ));
        self.send(format!(
            "session crashed ({}/{MAX_CRASHES}) — retrying in {}s",
            self.crash_count,
            delay.as_secs()
        ));
        self.set_state(AgentState::Crashed);
        self.pending_resume = Some(PendingResume {
            at: Instant::now() + delay,
            kind: ResumeKind::Crash,
        });
    }

    fn check_pending_resume(&mut self) {
        let due = matches!(&self.pending_resume, Some(p) if Instant::now() >= p.at);
        if !due {
            return;
        }
        let p = self.pending_resume.take().unwrap();
        if p.kind == ResumeKind::RateLimit {
            self.send("rate limit cleared — resuming session".into());
        }
        self.start_claude();
    }

    // ── command handling ──────────────────────────────────────────────────

    fn drain_commands(&mut self) {
        loop {
            match self.cmd_rx.try_recv() {
                Ok(cmd) => self.handle_command(&cmd),
                Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => return,
            }
        }
    }

    fn handle_command(&mut self, cmd: &str) {
        self.log(&format!("command: {cmd:?}"));
        match cmd {
            "start" | "go" => {
                if self.pane_id.is_none() {
                    self.pending_resume = None;
                    self.start_claude();
                } else {
                    self.send(format!("already {}", self.state.as_str()));
                }
            }
            "stop" | "quit" => {
                self.pending_resume = None;
                self.set_state(AgentState::Stopped);
                match &self.pane_id {
                    Some(p) => {
                        let p = p.clone();
                        self.tmux.kill_pane(&p);
                        // liveness poll notices, handle_exit sees Stopped.
                    }
                    None => self.send("stopped".into()),
                }
            }
            "restart" => {
                self.pending_resume = None;
                match &self.pane_id {
                    Some(p) => {
                        self.send("restarting...".into());
                        let p = p.clone();
                        self.tmux.kill_pane(&p);
                        // handle_exit restarts after the poll fires (JS parity;
                        // shows up as crash 1/10 with a 5s delay, as today).
                        self.crash_count = 0;
                        self.crash_backoff = BACKOFF_START;
                    }
                    None => self.start_claude(),
                }
            }
            "status" | "ping" | "?" => {
                let idle_s = self.last_output_at.elapsed().as_secs();
                let reset_str = self
                    .rate_limit_reset
                    .map(|r| format!(" reset@{}", r.with_timezone(&Local).format("%H:%M:%S")))
                    .unwrap_or_default();
                let sid8: String = self.session.session_id.chars().take(8).collect();
                self.send(format!(
                    "state: {}{}\nsession: {}...\nlast output: {}s ago\ncrashes: {} | cwd: {}",
                    self.state.as_str(),
                    reset_str,
                    sid8,
                    idle_s,
                    self.crash_count,
                    self.cfg.work_dir.display()
                ));
            }
            "kill session" => {
                // Nuclear: forget the session id so the next start is truly
                // fresh (and, restored in this port, boots with --session-id).
                self.session = SessionState::fresh();
                if let Err(e) = self.session.save(&self.cfg.state_path) {
                    self.log(&format!("WARN: cannot persist session state: {e}"));
                }
                if let Some(p) = self.pane_id.clone() {
                    self.tmux.kill_pane(&p);
                }
                self.send("session ID reset — next start will be a fresh conversation".into());
            }
            slash if slash.starts_with('/') => self.handle_slash(slash),
            _ => {} // unknown commands ignored (JS parity)
        }
    }

    fn handle_slash(&mut self, cmd: &str) {
        let slash = cmd.split_whitespace().next().unwrap_or(cmd);
        if !SLASH_ALLOW.contains(&slash) {
            self.send(format!(
                "refused {slash:?} — slash allowlist is: {}",
                SLASH_ALLOW.join(" ")
            ));
            return;
        }
        match self.pane_id.clone() {
            None => self.send(format!("no live session — can't send {slash} (start one first)")),
            Some(p) => {
                self.tmux.send_keys(&p, &[cmd, "Enter"]);
                self.send(format!("sent {cmd} to the live session"));
            }
        }
    }

    // ── heartbeat ─────────────────────────────────────────────────────────

    fn write_heartbeat(&self) {
        let hb = Heartbeat {
            schema: 1,
            version: env!("CARGO_PKG_VERSION").to_string(),
            pid: std::process::id(),
            state: self.state.as_str().to_string(),
            session_id: self.session.session_id.clone(),
            tmux_session: self.cfg.tmux_session.clone(),
            pane_id: self.pane_id.clone(),
            io_ok: true,
            crash_count: self.crash_count,
            started_at_epoch: self
                .started_at
                .map(|t| epoch_secs().saturating_sub(t.elapsed().as_secs()))
                .unwrap_or(0),
            last_sync_ok_epoch: self.last_sync_ok.load(Ordering::SeqCst),
            updated_at_epoch: epoch_secs(),
        };
        if let Ok(json) = serde_json::to_string(&hb) {
            if let Err(e) = write_file_atomic(&self.cfg.heartbeat_path, json.as_bytes(), None) {
                eprintln!("[manager] WARN: heartbeat write failed: {e}");
            }
        }
    }
}

fn epoch_to_utc(n: i64) -> Option<DateTime<Utc>> {
    // Heuristic: values >= 10^12 are milliseconds, else seconds.
    if n >= 1_000_000_000_000 {
        DateTime::<Utc>::from_timestamp_millis(n)
    } else {
        DateTime::<Utc>::from_timestamp(n, 0)
    }
}

/// JS parity: the async auto-accepter for Claude Code's startup prompts.
/// 30 attempts, 1s apart; every send targets OUR pane id explicitly.
fn auto_accept_prompts(tmux: Tmux, pane: String, shutdown: Arc<AtomicBool>) {
    let (mut trust, mut bypass, mut channel, mut summary) = (false, false, false, false);
    for _ in 0..30 {
        if trust && bypass && channel && summary {
            break;
        }
        std::thread::sleep(Duration::from_secs(1));
        if shutdown.load(Ordering::SeqCst) || !tmux.pane_alive(&pane) {
            break;
        }
        let out = tmux.capture(&pane);
        if !trust && out.contains("project you created") {
            tmux.send_keys(&pane, &["", "Enter"]);
            trust = true;
        }
        // Resume-from-summary prompt: Enter accepts the default (summary).
        // Broad phrase match to catch wording variants across versions.
        if !summary
            && (out.contains("resume from summary")
                || out.contains("Resume from summary")
                || out.contains("summary or full"))
        {
            tmux.send_keys(&pane, &["", "Enter"]);
            summary = true;
        }
        if !bypass && out.contains("Bypass Permissions mode") {
            tmux.send_keys(&pane, &["Down", ""]);
            std::thread::sleep(Duration::from_millis(200));
            tmux.send_keys(&pane, &["", "Enter"]);
            bypass = true;
        }
        if !channel && out.contains("Loading development channels") {
            tmux.send_keys(&pane, &["", "Enter"]);
            channel = true;
        }
    }
}
