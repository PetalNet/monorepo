//! The real "is location tracking actually working" proof (Parker's bar).
//!
//! Account B — a SYNTHETIC Point client (this process: real `point_core` MLS +
//! live REST + live WS) — links with account A (the physical phone, running
//! `track_a_main.dart`, producing LIVE GPS fixes) and subscribes to A's
//! location. This asserts B actually RECEIVES A's live positions as the phone
//! reports them, and that once A goes ghost the server stops delivering — B
//! receives none of the post-ghost fixes A still tries to send.
//!
//! Rendezvous is by shared RUNID + fixed usernames on the live server:
//!   A = tracka_<RUNID>@localhost   B = trackb_<RUNID>@localhost
//! B registers first and prints `B READY`; the harness then launches A on the
//! phone. Everything after is driven over the real server.
//!
//! Run (started by scripts/run-tracking-e2e.sh):
//!   RUNID=... EXPECT_PREGHOST=5 GHOST_SEQS=6,7 SERVER_URL=http://localhost:8330 \
//!     cargo test -p point-server --test tracking_e2e -- --ignored --nocapture

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use futures::{SinkExt, StreamExt};
use point_core::PointCrypto;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

struct Client {
    http: reqwest::Client,
    base: String,
    token: String,
    user_id: String,
}

impl Client {
    async fn register(base: &str, username: &str) -> Client {
        let http = reqwest::Client::new();
        let res = http
            .post(format!("{base}/api/register"))
            .json(&json!({ "username": username, "password": "correcthorsebattery" }))
            .send()
            .await
            .expect("register");
        assert!(res.status().is_success(), "register {username} failed");
        let v: Value = res.json().await.unwrap();
        Client {
            http,
            base: base.to_string(),
            token: v["token"].as_str().unwrap().to_string(),
            user_id: v["user_id"].as_str().unwrap().to_string(),
        }
    }

    async fn post(&self, path: &str, body: Value) -> (reqwest::StatusCode, Value) {
        let res = self
            .http
            .post(format!("{}{path}", self.base))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await
            .expect("post");
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    async fn get(&self, path: &str) -> Value {
        let res = self
            .http
            .get(format!("{}{path}", self.base))
            .bearer_auth(&self.token)
            .send()
            .await
            .expect("get");
        let text = res.text().await.unwrap_or_default();
        serde_json::from_str(&text).unwrap_or(Value::Null)
    }

    async fn upload_kps(&self, mls: &mut PointCrypto) {
        let kps: Vec<String> = (0..5)
            .map(|_| B64.encode(mls.generate_key_package().unwrap()))
            .collect();
        self.post("/api/mls/keys", json!({ "key_packages": kps })).await;
    }
}

fn env(k: &str, default: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| default.to_string())
}

#[tokio::test]
#[ignore = "needs the phone running track_a_main.dart; run via scripts/run-tracking-e2e.sh"]
async fn synthetic_b_tracks_a_live() {
    let base = env("SERVER_URL", "http://localhost:8330");
    let runid = env("RUNID", "dev");
    let expect_preghost: usize = env("EXPECT_PREGHOST", "5").parse().unwrap();
    let ghost_seqs: BTreeSet<i64> = env("GHOST_SEQS", "6,7")
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();
    let a_username = format!("tracka_{runid}");

    // 1. B registers + uploads a KeyPackage pool, then signals readiness so the
    //    harness can launch A (which will claim one of these KeyPackages).
    let bob = Client::register(&base, &format!("trackb_{runid}")).await;
    let mut bob_mls = PointCrypto::new(&bob.user_id).unwrap();
    bob.upload_kps(&mut bob_mls).await;
    let a_user_id = format!("{a_username}@localhost");
    println!("B READY: user_id={} tracking={}", bob.user_id, a_user_id);

    // 2. Accept A's incoming share request (A initiates; the mutual share is what
    //    lets the authz gate deliver A -> B). Poll until it shows up.
    let mut accepted = false;
    for _ in 0..120 {
        let reqs = bob.get("/api/shares/requests").await;
        if let Some(arr) = reqs.as_array() {
            if let Some(req) = arr.iter().find(|r| {
                r["from_user_id"].as_str() == Some(a_user_id.as_str())
                    || r["from_user_id"].as_str().is_some()
            }) {
                let id = req["id"].as_str().unwrap();
                bob.post(&format!("/api/shares/requests/{id}/accept"), json!({}))
                    .await;
                println!("B: accepted share request from {}", req["from_user_id"]);
                accepted = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(accepted, "B never saw a share request from A");

    // 3. Wait for A's Welcome in B's mailbox, then join the pairwise MLS group.
    let mut bob_gid: Option<Vec<u8>> = None;
    for _ in 0..120 {
        let msgs = bob.get("/api/mls/messages").await;
        if let Some(w) = msgs
            .as_array()
            .and_then(|a| a.iter().find(|m| m["message_type"] == json!("welcome")))
        {
            let welcome = B64.decode(w["payload"].as_str().unwrap()).unwrap();
            bob_gid = Some(bob_mls.process_welcome(&welcome).unwrap());
            println!("B: joined MLS group from A's Welcome");
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let bob_gid = bob_gid.expect("B never received A's Welcome");

    // 4. Connect B's WebSocket and authenticate.
    let ws_url = format!("{}/ws", base.replacen("http", "ws", 1));
    let (mut sock, _) = tokio_tungstenite::connect_async(&ws_url).await.expect("ws");
    sock.send(Message::Text(
        json!({ "type": "auth", "token": bob.token }).to_string(),
    ))
    .await
    .unwrap();
    loop {
        if let Some(Ok(Message::Text(t))) = sock.next().await {
            if serde_json::from_str::<Value>(&t).unwrap()["type"] == json!("auth.ok") {
                break;
            }
        }
    }
    println!("B: WS authenticated — listening for A's live location");

    // 5. Collect A's broadcast fixes, decrypting each. A sends `expect_preghost`
    //    fixes (seq 1..N), goes ghost, then still tries to send the `ghost_seqs`
    //    — the server must drop those, so B must never see them. End the window
    //    12s after the last received fix (the ghost gap) or after a hard cap.
    let mut received: Vec<(i64, f64, f64)> = Vec::new();
    let mut seqs = BTreeSet::new();
    let deadline = Duration::from_secs(90);
    let quiet_after_last = Duration::from_secs(12);
    let start = tokio::time::Instant::now();
    let mut last_rx = tokio::time::Instant::now();
    loop {
        if start.elapsed() > deadline {
            break;
        }
        if !received.is_empty() && last_rx.elapsed() > quiet_after_last {
            break; // the ghost gap
        }
        match tokio::time::timeout(Duration::from_secs(2), sock.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                let v: Value = serde_json::from_str(&t).unwrap();
                if v["type"] == json!("location.broadcast") {
                    let blob = B64.decode(v["blob"].as_str().unwrap()).unwrap();
                    let pt = bob_mls.decrypt(&bob_gid, &blob).unwrap();
                    let fix: Value = serde_json::from_slice(&pt).unwrap();
                    let seq = fix["seq"].as_i64().unwrap();
                    let lat = fix["lat"].as_f64().unwrap();
                    let lon = fix["lon"].as_f64().unwrap();
                    println!("B RECV: seq={seq} lat={lat} lon={lon}");
                    received.push((seq, lat, lon));
                    seqs.insert(seq);
                    last_rx = tokio::time::Instant::now();
                }
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_))) | Ok(None) => break,
            Err(_) => {} // 2s idle tick — loop and re-check deadlines
        }
    }

    // 6. Verdict.
    let preghost_expected: BTreeSet<i64> = (1..=expect_preghost as i64).collect();
    let got_preghost: BTreeSet<i64> = seqs.intersection(&preghost_expected).copied().collect();
    let leaked_ghost: BTreeSet<i64> = seqs.intersection(&ghost_seqs).copied().collect();

    println!("\n=== TRACKING RESULT ===");
    println!("B received {} fix(es) total from A:", received.len());
    for (seq, lat, lon) in &received {
        println!("  seq {seq}: ({lat}, {lon})");
    }
    println!("pre-ghost seqs expected {preghost_expected:?}, B got {got_preghost:?}");
    println!("post-ghost seqs A tried {ghost_seqs:?}, B leaked {leaked_ghost:?}");

    assert!(
        !got_preghost.is_empty(),
        "FAIL: B received NONE of A's live pre-ghost fixes — tracking is broken"
    );
    assert!(
        leaked_ghost.is_empty(),
        "FAIL: B received post-ghost fix(es) {leaked_ghost:?} — ghost did NOT stop delivery"
    );

    let all_preghost = got_preghost == preghost_expected;
    println!(
        "TRACKING-E2E: PASS — B tracked A's live location ({}/{} pre-ghost fixes delivered), \
         and ghost stopped delivery (0 of {} post-ghost fixes leaked){}",
        got_preghost.len(),
        expect_preghost,
        ghost_seqs.len(),
        if all_preghost {
            ""
        } else {
            " [partial pre-ghost delivery — see counts above]"
        }
    );
}
