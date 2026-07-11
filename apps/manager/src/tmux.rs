//! tmux plumbing with STABLE pane ownership.
//!
//! Hard requirement (this bit us before — see manager.js pane-fix comment,
//! 2026-07-01): humans open extra panes/windows in the same tmux session, so
//! the agent pane must be identified by a stable identity and every
//! send-keys / capture-pane / kill must target that pane id explicitly.
//! Never "the active pane", never "pane 0".
//!
//! Mechanism: at spawn we capture the new pane's globally-unique pane id
//! (`%N`, printed via `-P -F '#{pane_id}'`) and stamp the pane with a user
//! option `@agent_manager_owner=<pane_tag>` (tmux >= 3.0; the host runs 3.4).
//! Unlike pane *titles*, user options cannot be clobbered by the program in
//! the pane (Claude Code rewrites the terminal title via OSC escapes, so
//! titles are NOT stable). A pane counts as "ours" only if its id is listed
//! AND it still carries our tag; pane ids are never reused within a tmux
//! server's lifetime.
//!
//! Session names are targeted with `=<name>:` for exact-name matching (see
//! `starget`; bare `-t name` — and even `-t =name` outside `has-session` —
//! prefix-matches).
//!
//! # Failure modes (contract, exercised by `tests/tmux_it.rs`)
//!
//! Every query degrades to a calm negative — `false`, empty `Vec`/`String`,
//! `None` — in ALL of: tmux binary missing, server not running, session
//! gone, pane gone. Only the two spawn fns return `Err`, and their message
//! names the distinguished cause (binary missing / server not running /
//! session or pane not found / other, with tmux's stderr). The supervisor
//! treats a failed spawn or a failed tag as a crash with backoff — a host
//! without a usable tmux is a spawn failure, never degraded operation.

use std::process::Command;

pub const TAG_OPTION: &str = "@agent_manager_owner";

#[derive(Debug, Clone)]
pub struct Tmux {
    pub session: String,
    pub tag_value: String,
    /// Private socket name (`tmux -L <name>`); `None` targets the default
    /// server. Production always uses `None`; integration tests point this
    /// at a scratch server so they can never touch the live one.
    socket: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PaneInfo {
    pub id: String,
    pub tag: String,
}

/// Result of one tmux CLI invocation. `code == -1` covers both "binary
/// missing / not executable" (err holds the exec error) and the never-seen
/// "killed by signal"; real tmux failures carry tmux's own exit code and
/// stderr.
struct Exec {
    code: i32,
    out: String,
    err: String,
}

impl Exec {
    fn ok(&self) -> bool {
        self.code == 0
    }

    /// Human-readable cause, distinguishing the failure modes callers care
    /// about: binary missing, server not running, session/pane gone, other.
    fn describe_failure(&self) -> String {
        let err = self.err.trim();
        if err.starts_with("exec failed:") {
            format!("tmux binary missing or not executable ({err})")
        } else if err.contains("no server running") || err.contains("error connecting to") {
            format!("tmux server not running ({err})")
        } else if err.contains("can't find session") || err.contains("session not found") {
            format!("session not found ({err})")
        } else if err.contains("can't find pane") || err.contains("can't find window") {
            format!("pane/window not found ({err})")
        } else {
            format!("tmux exited {} ({err})", self.code)
        }
    }
}

impl Tmux {
    pub fn new(session: &str, tag_value: &str) -> Tmux {
        Tmux {
            session: session.to_string(),
            tag_value: tag_value.to_string(),
            socket: None,
        }
    }

    /// Like `new`, but every tmux call goes to the private socket
    /// `tmux -L <socket>` instead of the default server. Only the
    /// integration tests construct this (hence the allow): production code
    /// must stay on the default server, tests must never be.
    #[allow(dead_code)]
    pub fn with_socket(session: &str, tag_value: &str, socket: &str) -> Tmux {
        Tmux {
            session: session.to_string(),
            tag_value: tag_value.to_string(),
            socket: Some(socket.to_string()),
        }
    }

    fn run(&self, args: &[&str]) -> Exec {
        let mut cmd = Command::new("tmux");
        if let Some(s) = &self.socket {
            cmd.arg("-L").arg(s);
        }
        match cmd.args(args).output() {
            Ok(out) => Exec {
                code: out.status.code().unwrap_or(-1),
                out: String::from_utf8_lossy(&out.stdout).trim().to_string(),
                err: String::from_utf8_lossy(&out.stderr).trim().to_string(),
            },
            Err(e) => {
                eprintln!("[manager] tmux exec failed ({args:?}): {e}");
                Exec {
                    code: -1,
                    out: String::new(),
                    err: format!("exec failed: {e}"),
                }
            }
        }
    }

    /// Exact-match session target. The trailing `:` is load-bearing: a bare
    /// `=name` only exact-matches in `has-session`; in target-window/pane
    /// positions (`list-panes -s`, `new-window`) tmux still falls back to
    /// prefix matching, so without the `:` those could silently resolve to
    /// e.g. `janet-claude-experiments` when `janet-claude` is gone
    /// (observed on tmux 3.6a; covered by the exact-name integration test).
    fn starget(&self) -> String {
        format!("={}:", self.session)
    }

    /// False when the session is gone — and equally when the server is down
    /// or the tmux binary is missing (indistinguishable here by design; the
    /// spawn path is where the cause gets named).
    pub fn session_alive(&self) -> bool {
        self.run(&["has-session", "-t", &self.starget()]).ok()
    }

    /// All panes in our session, across all windows. Empty when the session
    /// is gone, the server is down, or tmux is missing — dead reads, never
    /// errors. On tmux < 3.0 panes are listed but the tag column is always
    /// empty (user options unsupported), so nothing ever matches ownership.
    ///
    /// The id/tag separator is a SPACE, not a tab: tmux >= 3.5 sanitizes
    /// control characters in list output to `_`, which fused the old
    /// tab-separated columns into one token and made every tag unreadable
    /// (caught by the containerized test run on 3.5a). Pane ids (`%N`)
    /// never contain spaces, so splitting on the first space is exact; the
    /// tag keeps any spaces it might contain.
    pub fn panes(&self) -> Vec<PaneInfo> {
        let fmt = format!("#{{pane_id}} #{{{}}}", TAG_OPTION);
        let e = self.run(&["list-panes", "-s", "-t", &self.starget(), "-F", &fmt]);
        if !e.ok() {
            return Vec::new();
        }
        e.out
            .lines()
            .filter_map(|l| {
                let mut it = l.splitn(2, ' ');
                let id = it.next()?.trim();
                if id.is_empty() || !id.starts_with('%') {
                    return None;
                }
                Some(PaneInfo {
                    id: id.to_string(),
                    tag: it.next().unwrap_or("").trim().to_string(),
                })
            })
            .collect()
    }

    /// The pane carrying OUR tag value, if any (adopt path). `None` on any
    /// failure mode (see `panes`) and when panes exist but none is ours —
    /// including a pane whose tag was clobbered to another value.
    pub fn find_tagged_pane(&self) -> Option<String> {
        self.panes()
            .into_iter()
            .find(|p| p.tag == self.tag_value)
            .map(|p| p.id)
    }

    /// Liveness: the pane id is still listed AND still carries our tag.
    /// False for a dead pane, a clobbered/foreign/missing tag, a dead
    /// session/server, or a missing tmux binary — every one of those means
    /// "not provably ours", and the supervisor's answer to all of them is
    /// the same respawn path.
    pub fn pane_alive(&self, pane_id: &str) -> bool {
        self.panes()
            .iter()
            .any(|p| p.id == pane_id && p.tag == self.tag_value)
    }

    /// Stamp the pane with our ownership tag. False when the pane is gone,
    /// the server is down, tmux is missing, or tmux < 3.0 (no pane user
    /// options — `set-option -p` fails). The spawn path treats false as a
    /// failed spawn and kills the fresh pane: ownership we cannot prove is
    /// ownership we do not have.
    pub fn tag_pane(&self, pane_id: &str) -> bool {
        self.run(&[
            "set-option",
            "-p",
            "-t",
            pane_id,
            TAG_OPTION,
            &self.tag_value,
        ])
        .ok()
    }

    /// Create the session detached, running `cmd` in its first pane; returns
    /// the new pane id. This is the ONE call that may start the tmux server
    /// (a down server is not an error here). `Err` — with the distinguished
    /// cause — when the binary is missing, the session already exists
    /// (callers route that through `new_window_with_cmd`), or tmux fails.
    pub fn new_session_with_cmd(&self, cmd: &str, w: u32, h: u32) -> Result<String, String> {
        let (ws, hs) = (w.to_string(), h.to_string());
        let e = self.run(&[
            "new-session",
            "-d",
            "-s",
            &self.session,
            "-x",
            &ws,
            "-y",
            &hs,
            "-P",
            "-F",
            "#{pane_id}",
            cmd,
        ]);
        if e.ok() && e.out.starts_with('%') {
            Ok(e.out)
        } else if e.ok() {
            Err(format!(
                "tmux new-session returned no pane id (out {:?})",
                e.out
            ))
        } else {
            Err(format!("tmux new-session failed: {}", e.describe_failure()))
        }
    }

    /// Session already exists (e.g. humans have panes open): run the agent in
    /// a NEW window instead of nuking their session. `-d` so an attached
    /// human's focus isn't yanked. `Err` — with the distinguished cause —
    /// when the exact session does NOT exist (this call never starts a
    /// server or session), the binary is missing, or tmux fails.
    pub fn new_window_with_cmd(&self, cmd: &str) -> Result<String, String> {
        let e = self.run(&[
            "new-window",
            "-d",
            "-t",
            &self.starget(),
            "-P",
            "-F",
            "#{pane_id}",
            cmd,
        ]);
        if e.ok() && e.out.starts_with('%') {
            Ok(e.out)
        } else if e.ok() {
            Err(format!(
                "tmux new-window returned no pane id (out {:?})",
                e.out
            ))
        } else {
            Err(format!("tmux new-window failed: {}", e.describe_failure()))
        }
    }

    /// JS-parity send-keys: each element is a tmux key argument (may be "").
    /// False when the pane is gone (any failure mode); keys sent to a dead
    /// pane are dropped by tmux, never rerouted to another pane.
    pub fn send_keys(&self, pane_id: &str, keys: &[&str]) -> bool {
        let mut args = vec!["send-keys", "-t", pane_id];
        args.extend_from_slice(keys);
        self.run(&args).ok()
    }

    /// Visible pane contents. CONTRACT: returns `""` both for a dead pane
    /// (any failure mode) and for a pane that is simply blank — callers that
    /// need the distinction must gate on `pane_alive` first (the auto-accept
    /// loop does exactly that).
    pub fn capture(&self, pane_id: &str) -> String {
        self.run(&["capture-pane", "-p", "-t", pane_id]).out
    }

    /// Kill ONLY our pane. If it is the last pane the session dies with it
    /// (same net effect as the JS manager's kill-session); if humans have
    /// other panes, theirs survive. False when the pane is already gone —
    /// callers treat that as "already dead", not as an error.
    pub fn kill_pane(&self, pane_id: &str) -> bool {
        self.run(&["kill-pane", "-t", pane_id]).ok()
    }
}
