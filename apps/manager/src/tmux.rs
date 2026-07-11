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
//! Session names are targeted with a leading `=` for exact-name matching
//! (bare `-t name` does prefix matching on no exact hit).

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

    fn run(&self, args: &[&str]) -> (i32, String) {
        let mut cmd = Command::new("tmux");
        if let Some(s) = &self.socket {
            cmd.arg("-L").arg(s);
        }
        match cmd.args(args).output() {
            Ok(out) => (
                out.status.code().unwrap_or(-1),
                String::from_utf8_lossy(&out.stdout).trim().to_string(),
            ),
            Err(e) => {
                eprintln!("[manager] tmux exec failed ({args:?}): {e}");
                (-1, String::new())
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

    pub fn session_alive(&self) -> bool {
        self.run(&["has-session", "-t", &self.starget()]).0 == 0
    }

    /// All panes in our session, across all windows.
    pub fn panes(&self) -> Vec<PaneInfo> {
        let fmt = format!("#{{pane_id}}\t#{{{}}}", TAG_OPTION);
        let (code, out) = self.run(&["list-panes", "-s", "-t", &self.starget(), "-F", &fmt]);
        if code != 0 {
            return Vec::new();
        }
        out.lines()
            .filter_map(|l| {
                let mut it = l.splitn(2, '\t');
                let id = it.next()?.trim();
                if id.is_empty() {
                    return None;
                }
                Some(PaneInfo {
                    id: id.to_string(),
                    tag: it.next().unwrap_or("").trim().to_string(),
                })
            })
            .collect()
    }

    pub fn find_tagged_pane(&self) -> Option<String> {
        self.panes()
            .into_iter()
            .find(|p| p.tag == self.tag_value)
            .map(|p| p.id)
    }

    /// Liveness: the pane id is still listed AND still carries our tag.
    pub fn pane_alive(&self, pane_id: &str) -> bool {
        self.panes()
            .iter()
            .any(|p| p.id == pane_id && p.tag == self.tag_value)
    }

    pub fn tag_pane(&self, pane_id: &str) -> bool {
        self.run(&[
            "set-option",
            "-p",
            "-t",
            pane_id,
            TAG_OPTION,
            &self.tag_value,
        ])
        .0 == 0
    }

    /// Create the session detached, running `cmd` in its first pane; returns
    /// the new pane id.
    pub fn new_session_with_cmd(&self, cmd: &str, w: u32, h: u32) -> Result<String, String> {
        let (ws, hs) = (w.to_string(), h.to_string());
        let (code, out) = self.run(&[
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
        if code == 0 && out.starts_with('%') {
            Ok(out)
        } else {
            Err(format!(
                "tmux new-session failed (code {code}, out {out:?})"
            ))
        }
    }

    /// Session already exists (e.g. humans have panes open): run the agent in
    /// a NEW window instead of nuking their session. `-d` so an attached
    /// human's focus isn't yanked.
    pub fn new_window_with_cmd(&self, cmd: &str) -> Result<String, String> {
        let (code, out) = self.run(&[
            "new-window",
            "-d",
            "-t",
            &self.starget(),
            "-P",
            "-F",
            "#{pane_id}",
            cmd,
        ]);
        if code == 0 && out.starts_with('%') {
            Ok(out)
        } else {
            Err(format!("tmux new-window failed (code {code}, out {out:?})"))
        }
    }

    /// JS-parity send-keys: each element is a tmux key argument (may be "").
    pub fn send_keys(&self, pane_id: &str, keys: &[&str]) -> bool {
        let mut args = vec!["send-keys", "-t", pane_id];
        args.extend_from_slice(keys);
        self.run(&args).0 == 0
    }

    pub fn capture(&self, pane_id: &str) -> String {
        self.run(&["capture-pane", "-p", "-t", pane_id]).1
    }

    /// Kill ONLY our pane. If it is the last pane the session dies with it
    /// (same net effect as the JS manager's kill-session); if humans have
    /// other panes, theirs survive.
    pub fn kill_pane(&self, pane_id: &str) -> bool {
        self.run(&["kill-pane", "-t", pane_id]).0 == 0
    }
}
