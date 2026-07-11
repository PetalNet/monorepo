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
//! # Failure modes (contract; exercised by `tests/tmux_it.rs` on tmux
//! # 3.4/3.5/3.6 — the tmux < 3.0 rows are asserted by design, not executed:
//! # no pre-3.0 binary exists anywhere in the fleet to test against)
//!
//! Every query degrades to a calm negative — `false`, empty `Vec`/`String`,
//! `None` — in ALL of: tmux binary missing, server not running, session
//! gone, pane gone. The spawn fns and `tag_pane` return `Err` with the
//! distinguished cause (binary missing / cannot connect to server /
//! session or pane not found / other, with tmux's stderr). The supervisor
//! treats a failed spawn or a failed tag as a crash with backoff — a host
//! without a usable tmux is a spawn failure, never degraded operation.
//!
//! Pane-id reuse caveat: ids are unique within ONE server's lifetime. A
//! stale id held across a server restart can name a stranger's pane on the
//! new server; `kill_pane` guards against this (ownership recheck), while
//! `send_keys`/`capture` rely on callers gating on `pane_alive` (the
//! supervisor and the auto-accept loop both do).

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
            // "error connecting to" also covers socket path/permission
            // problems, not only a dead server — say so.
            format!("cannot connect to tmux server — not running, or socket path/permission problem ({err})")
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
    /// The id/tag separator is a SPACE, not a tab: tmux 3.4 AND 3.5 (3.4
    /// is the pinned live-host version) sanitize control characters in
    /// list output to `_`, which fused the old tab-separated columns into
    /// one token and made every tag unreadable; 3.6a happens to preserve
    /// the tab, which is why host runs never caught it (found by the
    /// containerized run on 3.5a, reproduced on 3.4). Pane ids (`%N`)
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

    /// Stamp the pane with our ownership tag. `Err` names the cause: pane
    /// already gone (an agent that dies at startup can lose the race with
    /// the tag — far more common than any tmux problem), server
    /// unreachable, binary missing, or tmux < 3.0 (`set-option -p`
    /// unsupported; surfaces as the generic arm carrying tmux's stderr).
    /// The spawn path treats any `Err` as a failed spawn and kills the
    /// fresh pane: ownership we cannot prove is ownership we do not have.
    pub fn tag_pane(&self, pane_id: &str) -> Result<(), String> {
        let e = self.run(&[
            "set-option",
            "-p",
            "-t",
            pane_id,
            TAG_OPTION,
            &self.tag_value,
        ]);
        if e.ok() {
            Ok(())
        } else {
            Err(e.describe_failure())
        }
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
    /// pane are dropped by tmux, never rerouted to another pane. CAVEAT:
    /// the id is trusted as-is — after a server restart the same id can
    /// name a stranger's pane, so callers must gate on `pane_alive` (both
    /// callers do; the supervisor holds ids only while its liveness poll
    /// confirms them).
    pub fn send_keys(&self, pane_id: &str, keys: &[&str]) -> bool {
        let mut args = vec!["send-keys", "-t", pane_id];
        args.extend_from_slice(keys);
        self.run(&args).ok()
    }

    /// Visible pane contents. CONTRACT: returns `""` both for a dead pane
    /// (any failure mode) and for a pane that is simply blank — callers that
    /// need the distinction must gate on `pane_alive` first (the auto-accept
    /// loop does exactly that). The same pane-id-reuse caveat as `send_keys`
    /// applies.
    pub fn capture(&self, pane_id: &str) -> String {
        self.run(&["capture-pane", "-p", "-t", pane_id]).out
    }

    /// Kill ONLY our pane. Refuses — false, nothing killed — unless the id
    /// is currently listed in OUR exact session carrying our tag or no tag
    /// at all (untagged allowed so the spawn path can clean up a pane whose
    /// tagging itself failed). This guards the destructive op against
    /// pane-id reuse: ids are unique within one server's lifetime, but a
    /// stale id can name a stranger's pane on a NEW server — cross-session
    /// and foreign-tagged panes are never killed. False therefore means
    /// EITHER "already gone / not provably ours" (callers treat as already
    /// dead) OR "tmux unreachable, kill unconfirmed" — graceful shutdown
    /// logs when it cannot confirm. Residual, accepted: a millisecond
    /// check-then-kill window (tmux has no conditional kill), and an
    /// untagged pane in a same-named session on a new server is
    /// indistinguishable from our own failed-tag cleanup target. If ours
    /// was the last pane the session dies with it (same net effect as the
    /// JS manager's kill-session); human panes survive.
    pub fn kill_pane(&self, pane_id: &str) -> bool {
        let killable = self
            .panes()
            .iter()
            .any(|p| p.id == pane_id && (p.tag == self.tag_value || p.tag.is_empty()));
        killable && self.run(&["kill-pane", "-t", pane_id]).ok()
    }
}

/// Pure tests for the failure classifier (all arms, including the
/// exec-failure one that integration tests can't reach without mutating
/// PATH process-globally).
#[cfg(test)]
mod tests {
    use super::*;

    fn ex(code: i32, err: &str) -> Exec {
        Exec {
            code,
            out: String::new(),
            err: err.into(),
        }
    }

    #[test]
    fn describe_failure_names_each_cause() {
        let cases: &[(i32, &str, &str)] = &[
            (
                -1,
                "exec failed: No such file or directory (os error 2)",
                "binary missing",
            ),
            (
                1,
                "no server running on /tmp/tmux-1000/default",
                "cannot connect to tmux server",
            ),
            (
                1,
                "error connecting to /tmp/tmux-1000/n12test-x (No such file or directory)",
                "cannot connect to tmux server",
            ),
            (1, "can't find session: janet-claude", "session not found"),
            (1, "session not found: janet-claude", "session not found"),
            (1, "can't find pane: %7", "pane/window not found"),
            (1, "can't find window: @3", "pane/window not found"),
            (1, "duplicate session: janet-claude", "duplicate session"),
        ];
        for (code, err, want) in cases {
            let got = ex(*code, err).describe_failure();
            assert!(
                got.contains(want),
                "stderr {err:?}: got {got:?}, want substring {want:?}"
            );
            assert!(
                got.contains(err),
                "stderr {err:?} must be preserved in {got:?}"
            );
        }
    }
}
