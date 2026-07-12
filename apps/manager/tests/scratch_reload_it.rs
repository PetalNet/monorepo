//! SCRATCH TEST (adversarial review) — delete after running.
//!
//! Proves the reload-cooldown recovery-latency behavior of the sync loop when
//! the token authority revokes the old token BEFORE the creds file carries
//! the new one (a realistic rotation ordering): the loop charges the 30s
//! cooldown on the "token unchanged" reload, so even though the fresh token
//! is available ~1s later, the manager stays deaf for the full cooldown.
//!
//! Also counts homeserver hits to confirm there is no busy-loop.

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

/// Minimal HTTP stub: 401 M_UNKNOWN_TOKEN unless the bearer token is "good".
fn spawn_stub(hits: Arc<AtomicU64>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut s) = stream else { continue };
            hits.fetch_add(1, Ordering::SeqCst);
            let mut buf = [0u8; 4096];
            let mut req = Vec::new();
            // read until end of headers (GET /sync has no body)
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
fn rotation_with_file_lag_recovery_takes_a_full_cooldown() {
    let hits = Arc::new(AtomicU64::new(0));
    let hs = spawn_stub(Arc::clone(&hits));

    // Manager booted with the (now revoked) old token.
    let client = matrix::MatrixClient::new(&creds(&hs, "revoked"), "!room:example");
    let shutdown = Arc::new(AtomicBool::new(false));
    let last_sync_ok = Arc::new(AtomicU64::new(0));

    // Creds file contents over time: the authority revoked the old token
    // first; the file still holds it on the FIRST reload (write lag ~1 reload),
    // and holds the fresh token on every reload after that.
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

    // Wait for the loop to heal (last_sync_ok becomes nonzero), up to 60s.
    let mut healed_after = None;
    while start.elapsed() < Duration::from_secs(60) {
        if last_sync_ok.load(Ordering::SeqCst) != 0 {
            healed_after = Some(start.elapsed());
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    shutdown.store(true, Ordering::SeqCst);

    let healed = healed_after.expect("sync loop never healed within 60s");
    let reloads = reload_calls.load(Ordering::SeqCst);
    let total_hits = hits.load(Ordering::SeqCst);
    eprintln!("healed after {healed:?}; creds reloads: {reloads}; homeserver hits: {total_hits}");

    // No busy-loop: with 5s backoff, <= ~2 hits per 5s window pre-heal.
    assert!(
        total_hits < 25,
        "sync loop hammered the homeserver: {total_hits} hits"
    );
    // The fresh token was available from the SECOND reload (~5s in), but the
    // cooldown was charged on the unchanged-token reload, so recovery takes
    // the full RELOAD_COOLDOWN_SECS. This assertion documents that latency.
    assert!(
        healed >= Duration::from_secs(28),
        "expected recovery to be delayed by the burned cooldown; healed in {healed:?}"
    );
}
