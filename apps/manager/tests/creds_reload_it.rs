//! Integration test for the Matrix creds hot-reload sync loop (self-heal).
//!
//! Drives the real `spawn_command_loop` against a local HTTP stub that returns
//! 401 M_UNKNOWN_TOKEN until the bearer token is the rotated value. Proves:
//!  - the loop recovers PROMPTLY after the creds file catches up (no 30s
//!    cooldown outage — adversarial-review #2), even when the file lags the
//!    revocation by one reload, and
//!  - it does not hammer the homeserver while the token is bad.
//!
//! The stub responds immediately (no long-poll); the test exits the moment the
//! loop heals, so post-heal syncs don't accumulate.

#[path = "../src/config.rs"]
#[allow(dead_code)]
mod config;
#[path = "../src/matrix.rs"]
#[allow(dead_code)]
mod matrix;
#[path = "../src/state.rs"]
#[allow(dead_code)]
mod state;

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use config::MatrixCreds;

fn creds(hs: &str, token: &str) -> MatrixCreds {
    MatrixCreds {
        homeserver: hs.into(),
        access_token: token.into(),
        user_id: "@janet:example".into(),
    }
}

/// Minimal HTTP stub: 200 with a next_batch when the bearer token is "good",
/// else 401 M_UNKNOWN_TOKEN. Counts requests.
fn spawn_stub(hits: Arc<AtomicU64>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut s) = stream else { continue };
            hits.fetch_add(1, Ordering::SeqCst);
            let mut buf = [0u8; 4096];
            let mut req = Vec::new();
            loop {
                match s.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        req.extend_from_slice(&buf[..n]);
                        if req.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            let text = String::from_utf8_lossy(&req);
            let authed = text
                .lines()
                .any(|l| l.eq_ignore_ascii_case("authorization: bearer good"));
            let (status, body) = if authed {
                // Simulate the real server honoring the long-poll timeout so
                // post-heal syncs are paced (a real /sync blocks up to 30s);
                // otherwise the loop would sync back-to-back in the test's
                // heal-detection window and inflate the hit count.
                std::thread::sleep(Duration::from_millis(500));
                ("200 OK", r#"{"next_batch":"s1"}"#)
            } else {
                (
                    "401 Unauthorized",
                    r#"{"errcode":"M_UNKNOWN_TOKEN","error":"Unrecognised access token"}"#,
                )
            };
            let resp = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = s.write_all(resp.as_bytes());
        }
    });
    format!("http://{addr}")
}

#[test]
fn sync_loop_recovers_promptly_after_a_lagging_token_rotation() {
    let hits = Arc::new(AtomicU64::new(0));
    let hs = spawn_stub(Arc::clone(&hits));

    // Booted with the revoked token.
    let client = matrix::MatrixClient::new(&creds(&hs, "revoked"), "!room:example");
    let shutdown = Arc::new(AtomicBool::new(false));
    let last_sync_ok = Arc::new(AtomicU64::new(0));

    // The creds file LAGS: the first reload still returns the old token (the
    // authority revoked it but hasn't rewritten the file yet); every reload
    // after that returns the fresh token. This is the case the old cooldown
    // logic turned into a 30s outage.
    let reload_calls = Arc::new(AtomicU64::new(0));
    let rc = Arc::clone(&reload_calls);
    let hs2 = hs.clone();
    let reload = move || {
        let n = rc.fetch_add(1, Ordering::SeqCst);
        Ok(creds(&hs2, if n == 0 { "revoked" } else { "good" }))
    };

    let start = Instant::now();
    let _rx = matrix::spawn_command_loop(
        client,
        Arc::clone(&shutdown),
        Arc::clone(&last_sync_ok),
        Some(reload),
    );

    // Heal = last_sync_ok becomes nonzero.
    let mut healed_after = None;
    while start.elapsed() < Duration::from_secs(30) {
        if last_sync_ok.load(Ordering::SeqCst) != 0 {
            healed_after = Some(start.elapsed());
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    shutdown.store(true, Ordering::SeqCst);

    let healed = healed_after.expect("sync loop never healed within 30s");
    let total_hits = hits.load(Ordering::SeqCst);
    eprintln!(
        "healed after {healed:?}; creds reloads: {}; homeserver hits: {total_hits}",
        reload_calls.load(Ordering::SeqCst)
    );

    // PROMPT recovery: the fresh token is available on the 2nd reload (~one 5s
    // backoff after boot), and the loop must adopt it then — NOT after a 30s
    // cooldown. Allow generous slack for a loaded CI box but well under 30s.
    assert!(
        healed < Duration::from_secs(20),
        "recovery should be prompt after the file catches up, not cooldown-delayed; healed in {healed:?}"
    );
    // No hammering while the token is bad: ~1 sync per 5s backoff pre-heal.
    assert!(
        total_hits < 15,
        "sync loop hammered the homeserver: {total_hits} hits"
    );
}
