//! Integration tests for the tmux pane-ownership layer (N1.2).
//!
//! Double-gated so ordinary `cargo test` / CI-less runs never spawn a tmux
//! server: every test is `#[ignore]` AND skips unless `N12_TMUX_IT=1`. Run:
//!
//!   N12_TMUX_IT=1 cargo test --test tmux_it -- --ignored
//!
//! Isolation contract (§0 of the brief): each test runs its own scratch tmux
//! server on a PRIVATE socket (`tmux -L n12test-<pid>-<label>`, i.e.
//! `/tmp/tmux-$UID/n12test-*`) and kills exactly that server on every exit
//! path (Drop guard, panic included). The default server — which on the live
//! host carries the shared `janet-claude` session — is never contacted.
//!
//! The crate is bin-only, so the module under test is included by path; it is
//! the same source the binary compiles.

#[path = "../src/tmux.rs"]
#[allow(dead_code)] // the tests exercise a subset of the module's API
mod tmux;

use std::process::Command;
use std::time::{Duration, Instant};

use tmux::{Tmux, TAG_OPTION};

const SESSION: &str = "n12it";
const TAG: &str = "n12-mgr-primary";

fn it_enabled() -> bool {
    std::env::var("N12_TMUX_IT").ok().as_deref() == Some("1")
}

/// Every test starts with this; keeps the env gate in one place.
macro_rules! require_it {
    () => {
        if !it_enabled() {
            eprintln!("skipping: set N12_TMUX_IT=1 to run tmux integration tests");
            return;
        }
    };
}

/// Owns one scratch tmux server on a private socket; kills it on drop so no
/// exit path (assert failure included) leaks a server.
struct Scratch {
    socket: String,
}

impl Scratch {
    fn new(label: &str) -> Scratch {
        Scratch {
            socket: format!("n12test-{}-{}", std::process::id(), label),
        }
    }

    fn tmux(&self, session: &str, tag: &str) -> Tmux {
        Tmux::with_socket(session, tag, &self.socket)
    }

    /// Raw tmux CLI against this scratch socket, for setting up decoys and
    /// for asserting server state independently of the code under test.
    fn raw(&self, args: &[&str]) -> (i32, String) {
        let out = Command::new("tmux")
            .arg("-L")
            .arg(&self.socket)
            .args(args)
            .output()
            .expect("tmux binary must be runnable for integration tests");
        (
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stdout).trim().to_string(),
        )
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = Command::new("tmux")
            .args(["-L", &self.socket, "kill-server"])
            .output();
    }
}

/// Poll `cond` up to `timeout`; tmux pane content/state changes are async.
fn wait_until(timeout: Duration, mut cond: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if cond() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Spawn the session with a long-lived first pane and tag it ours.
fn spawn_tagged(t: &Tmux) -> String {
    let pane = t
        .new_session_with_cmd("sleep 300", 80, 24)
        .expect("new_session_with_cmd");
    assert!(pane.starts_with('%'), "pane id shape: {pane:?}");
    assert!(t.tag_pane(&pane), "tag_pane");
    pane
}

// ── ownership: find / liveness / kill ────────────────────────────────────

#[test]
#[ignore]
fn find_tagged_pane_finds_exactly_ours_among_decoys() {
    require_it!();
    let s = Scratch::new("decoys");
    let t = s.tmux(SESSION, TAG);
    let ours = spawn_tagged(&t);

    // Decoy 1: untagged split pane (a human's shell).
    let (c, _) = s.raw(&["split-window", "-d", "-t", &format!("={SESSION}:")]);
    assert_eq!(c, 0, "decoy split");
    // Decoy 2: a pane tagged by a DIFFERENT manager.
    let (c, other) = s.raw(&[
        "split-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        &format!("={SESSION}:"),
    ]);
    assert_eq!(c, 0, "decoy tagged split");
    let (c, _) = s.raw(&["set-option", "-p", "-t", &other, TAG_OPTION, "someone-else"]);
    assert_eq!(c, 0, "decoy tag");
    // Decoy 3: an untagged extra window.
    let (c, _) = s.raw(&["new-window", "-d", "-t", &format!("={SESSION}:")]);
    assert_eq!(c, 0, "decoy window");

    assert_eq!(t.panes().len(), 4, "session should hold ours + 3 decoys");
    assert_eq!(t.find_tagged_pane(), Some(ours.clone()));
    assert!(t.pane_alive(&ours));
    assert!(!t.pane_alive(&other), "foreign tag is not ours");
}

#[test]
#[ignore]
fn pane_alive_goes_false_after_kill_and_last_pane_takes_session() {
    require_it!();
    let s = Scratch::new("kill");
    let t = s.tmux(SESSION, TAG);
    let pane = spawn_tagged(&t);

    assert!(t.pane_alive(&pane));
    assert!(t.session_alive());
    assert!(t.kill_pane(&pane));
    assert!(
        wait_until(Duration::from_secs(5), || !t.pane_alive(&pane)),
        "pane must read dead after kill"
    );
    // It was the only pane: the session dies with it (documented contract).
    assert!(
        wait_until(Duration::from_secs(5), || !t.session_alive()),
        "last pane takes the session down"
    );
    assert_eq!(t.find_tagged_pane(), None);
}

#[test]
#[ignore]
fn send_keys_capture_round_trip() {
    require_it!();
    let s = Scratch::new("roundtrip");
    let t = s.tmux(SESSION, TAG);
    let pane = t
        .new_session_with_cmd("sh", 80, 24)
        .expect("interactive sh pane");
    assert!(t.tag_pane(&pane));

    // The output line is "rt:42"; the *typed* line contains the arithmetic
    // expansion, so matching "rt:42" proves we captured output, not input.
    assert!(t.send_keys(&pane, &["echo rt:$((6*7))", "Enter"]));
    assert!(
        wait_until(Duration::from_secs(10), || t
            .capture(&pane)
            .contains("rt:42")),
        "echoed output must appear in capture; got:\n{}",
        t.capture(&pane)
    );
}

#[test]
#[ignore]
fn untagged_pane_never_matches() {
    require_it!();
    let s = Scratch::new("untagged");
    let t = s.tmux(SESSION, TAG);
    let pane = t
        .new_session_with_cmd("sleep 300", 80, 24)
        .expect("new_session_with_cmd");
    // Deliberately NOT tagged.
    assert_eq!(t.panes().len(), 1, "pane is listed");
    assert_eq!(t.find_tagged_pane(), None, "but never matches ownership");
    assert!(!t.pane_alive(&pane), "liveness requires id AND tag");
}

#[test]
#[ignore]
fn second_manager_tag_value_does_not_collide() {
    require_it!();
    let s = Scratch::new("twomgrs");
    let a = s.tmux(SESSION, "n12-mgr-a");
    let b = s.tmux(SESSION, "n12-mgr-b");

    let pane_a = spawn_tagged_for(&a);
    let pane_b = b.new_window_with_cmd("sleep 300").expect("b's window");
    assert!(b.tag_pane(&pane_b));

    assert_eq!(a.find_tagged_pane(), Some(pane_a.clone()));
    assert_eq!(b.find_tagged_pane(), Some(pane_b.clone()));
    assert_ne!(pane_a, pane_b);
    assert!(a.pane_alive(&pane_a) && !a.pane_alive(&pane_b));
    assert!(b.pane_alive(&pane_b) && !b.pane_alive(&pane_a));

    // Killing B's pane must not disturb A's.
    assert!(b.kill_pane(&pane_b));
    assert!(wait_until(Duration::from_secs(5), || !b.pane_alive(&pane_b)));
    assert!(a.pane_alive(&pane_a), "A's pane survives B's kill");
}

/// Same as `spawn_tagged` but named for the two-manager test's readability.
fn spawn_tagged_for(t: &Tmux) -> String {
    spawn_tagged(t)
}

#[test]
#[ignore]
fn clobbered_tag_means_pane_is_no_longer_ours() {
    require_it!();
    let s = Scratch::new("clobber");
    let t = s.tmux(SESSION, TAG);
    let pane = spawn_tagged(&t);
    assert!(t.pane_alive(&pane));

    // Someone overwrites our user option (the locked design treats this as
    // pane death: liveness = id AND tag, so the supervisor respawns).
    let (c, _) = s.raw(&["set-option", "-p", "-t", &pane, TAG_OPTION, "intruder"]);
    assert_eq!(c, 0);
    assert!(!t.pane_alive(&pane), "clobbered tag = not ours");
    assert_eq!(t.find_tagged_pane(), None);

    // Re-tagging (what a fresh spawn does) restores ownership.
    assert!(t.tag_pane(&pane));
    assert!(t.pane_alive(&pane));
}

// ── session targeting ────────────────────────────────────────────────────

#[test]
#[ignore]
fn exact_name_targeting_never_prefix_matches() {
    require_it!();
    let s = Scratch::new("exact");
    // Only "n12it-longer" exists; we manage the strict prefix "n12it".
    let long = s.tmux("n12it-longer", TAG);
    spawn_tagged(&long);

    let short = s.tmux("n12it", TAG);
    assert!(long.session_alive());
    assert!(
        !short.session_alive(),
        "`=name` must not match the longer session"
    );
    assert!(short.panes().is_empty(), "no cross-session pane listing");
    assert!(
        short.new_window_with_cmd("sleep 300").is_err(),
        "new_window must not land in the longer session"
    );

    // Sanity: bare -t WOULD prefix-match — this is exactly why starget()
    // prepends `=` (locked decision).
    let (c, _) = s.raw(&["has-session", "-t", "n12it"]);
    assert_eq!(c, 0, "bare -t prefix-matches; the = guard is load-bearing");
}

// ── failure modes ────────────────────────────────────────────────────────

#[test]
#[ignore]
fn server_down_every_query_degrades_calmly_and_spawn_starts_the_server() {
    require_it!();
    let s = Scratch::new("serverdown");
    let t = s.tmux(SESSION, TAG);

    // No server on this socket yet: every query is a calm negative.
    assert!(!t.session_alive());
    assert!(t.panes().is_empty());
    assert_eq!(t.find_tagged_pane(), None);
    assert!(!t.pane_alive("%0"));
    assert!(!t.tag_pane("%0"));
    assert!(!t.send_keys("%0", &["x", "Enter"]));
    assert_eq!(t.capture("%0"), "");
    assert!(!t.kill_pane("%0"));
    let err = t
        .new_window_with_cmd("sleep 300")
        .expect_err("new-window cannot start a server");
    assert!(
        err.contains("server not running"),
        "spawn error names the cause; got: {err}"
    );

    // new_session_with_cmd is the one call that BOOTS the server.
    let pane = t.new_session_with_cmd("sleep 300", 80, 24).expect("boot");
    assert!(t.session_alive());
    assert!(t.tag_pane(&pane));
    assert_eq!(t.find_tagged_pane(), Some(pane));
}

#[test]
#[ignore]
fn session_up_pane_gone_is_distinguishable_from_session_gone() {
    require_it!();
    let s = Scratch::new("panegone");
    let t = s.tmux(SESSION, TAG);
    let ours = spawn_tagged(&t);

    // A second (human) pane keeps the session alive after ours dies.
    let (c, _) = s.raw(&["split-window", "-d", "-t", &format!("={SESSION}:")]);
    assert_eq!(c, 0);

    // Kill OUR pane out from under the manager (tmux kill, not ours).
    let (c, _) = s.raw(&["kill-pane", "-t", &ours]);
    assert_eq!(c, 0);

    assert!(t.session_alive(), "humans keep the session open");
    assert!(!t.pane_alive(&ours), "our pane reads dead");
    assert_eq!(t.find_tagged_pane(), None);
    assert_eq!(t.panes().len(), 1, "the human pane is still listed");
    // Dead-id operations are calm negatives, not panics/hangs.
    assert!(!t.send_keys(&ours, &["x", "Enter"]));
    assert_eq!(t.capture(&ours), "", "capture of a dead pane is empty");
    assert!(!t.kill_pane(&ours));

    // And a duplicate new-session on a live name fails cleanly, naming the
    // cause (the supervisor's spawn path routes this into new_window).
    let err = t
        .new_session_with_cmd("sleep 300", 80, 24)
        .expect_err("duplicate session must fail");
    assert!(
        err.contains("duplicate session"),
        "spawn error carries tmux's stderr; got: {err}"
    );
}

#[test]
#[ignore]
fn scratch_server_cleanup_kills_only_our_socket() {
    require_it!();
    // Two scratch servers side by side; dropping one leaves the other.
    let s1 = Scratch::new("cleanup-a");
    let s2 = Scratch::new("cleanup-b");
    let t1 = s1.tmux(SESSION, TAG);
    let t2 = s2.tmux(SESSION, TAG);
    spawn_tagged(&t1);
    spawn_tagged(&t2);
    assert!(t1.session_alive() && t2.session_alive());

    drop(s1);
    assert!(
        wait_until(Duration::from_secs(5), || !t1.session_alive()),
        "s1's server is gone"
    );
    assert!(t2.session_alive(), "s2's server is untouched");
}
