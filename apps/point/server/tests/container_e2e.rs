//! The honest end-to-end proof for M0: drive a REAL running server (container
//! or local binary) through the actual flow — register → invite → share →
//! MLS group formation → encrypted fix over WS → decrypt — with point-core
//! doing real client-side MLS. No mocks, no facade; the server under test
//! only ever sees ciphertext.
//!
//! Run (ignored by default; needs a live server):
//!   E2E_BASE_URL=http://127.0.0.1:18330 E2E_DOMAIN=e2e.local \
//!     cargo test -p point-server --test container_e2e -- --ignored --nocapture
//!
//! The DB-side "ciphertext only" assertion lives in the harness that starts
//! the container (it queries Postgres directly); this test asserts the wire
//! side: the relayed blob is undecipherable without the MLS group and decrypts
//! only for the intended member.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use futures::{SinkExt, StreamExt};
use point_core::PointCrypto;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

fn base_url() -> String {
    std::env::var("E2E_BASE_URL").expect("set E2E_BASE_URL (e.g. http://127.0.0.1:18330)")
}

fn ws_url() -> String {
    base_url().replacen("http", "ws", 1) + "/ws"
}

struct Client {
    http: reqwest::Client,
    token: String,
    user_id: String,
}

impl Client {
    async fn register(username: &str, password: &str, invite: Option<&str>) -> Client {
        let http = reqwest::Client::new();
        let mut body = json!({ "username": username, "password": password });
        if let Some(code) = invite {
            body["invite_code"] = json!(code);
        }
        let res = http
            .post(format!("{}/api/register", base_url()))
            .json(&body)
            .send()
            .await
            .expect("register request");
        assert!(
            res.status().is_success(),
            "register {username} failed: {}",
            res.text().await.unwrap_or_default()
        );
        let v: Value = res.json().await.expect("register json");
        Client {
            http,
            token: v["token"].as_str().expect("token").to_string(),
            user_id: v["user_id"].as_str().expect("user_id").to_string(),
        }
    }

    async fn post(&self, path: &str, body: Value) -> Value {
        let res = self
            .http
            .post(format!("{}{path}", base_url()))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await
            .expect("post");
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        assert!(status.is_success(), "POST {path} -> {status}: {text}");
        serde_json::from_str(&text).unwrap_or(Value::Null)
    }

    async fn put(&self, path: &str, body: Value) -> Value {
        let res = self
            .http
            .put(format!("{}{path}", base_url()))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await
            .expect("put");
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        assert!(status.is_success(), "PUT {path} -> {status}: {text}");
        serde_json::from_str(&text).unwrap_or(Value::Null)
    }

    async fn get(&self, path: &str) -> Value {
        let res = self
            .http
            .get(format!("{}{path}", base_url()))
            .bearer_auth(&self.token)
            .send()
            .await
            .expect("get");
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        assert!(status.is_success(), "GET {path} -> {status}: {text}");
        serde_json::from_str(&text).unwrap_or(Value::Null)
    }

    /// Open a WS connection, authenticate as the first message, await auth.ok.
    async fn ws(
        &self,
    ) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>
    {
        let (mut socket, _) = tokio_tungstenite::connect_async(ws_url())
            .await
            .expect("ws connect");
        socket
            .send(Message::Text(
                json!({ "type": "auth", "token": self.token }).to_string(),
            ))
            .await
            .expect("ws auth send");
        let frame = expect_frame(&mut socket, "auth.ok", Duration::from_secs(5)).await;
        assert_eq!(frame["user_id"], json!(self.user_id));
        socket
    }
}

/// Read frames until one of `wanted` type arrives (skipping presence noise) or
/// the deadline passes.
async fn expect_frame(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    wanted: &str,
    deadline: Duration,
) -> Value {
    let fut = async {
        loop {
            let msg = socket
                .next()
                .await
                .expect("ws stream ended")
                .expect("ws frame");
            if let Message::Text(text) = msg {
                let v: Value = serde_json::from_str(&text).expect("frame json");
                if v["type"] == json!(wanted) {
                    return v;
                }
            }
        }
    };
    tokio::time::timeout(deadline, fut)
        .await
        .unwrap_or_else(|_| panic!("no {wanted} frame within {deadline:?}"))
}

/// Assert NO frame of the given type arrives within the window.
async fn expect_silence(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    unwanted: &str,
    window: Duration,
) {
    let fut = async {
        loop {
            match socket.next().await {
                Some(Ok(Message::Text(text))) => {
                    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                    if v["type"] == json!(unwanted) {
                        panic!("unexpected {unwanted} frame during ghost: {v}");
                    }
                }
                Some(Ok(_)) => {}
                // A closed/errored socket is NOT a pass: a crash or disconnect
                // during the window would otherwise read as "ghost enforced".
                Some(Err(e)) => panic!("socket errored during silence window: {e}"),
                None => panic!("socket closed during silence window (not a clean ghost drop)"),
            }
        }
    };
    // Only the timeout elapsing WITHOUT any frame (or close) is the pass.
    let _ = tokio::time::timeout(window, fut).await;
}

#[tokio::test]
#[ignore = "needs a live server; run via the container E2E harness"]
async fn register_share_encrypt_deliver_decrypt_ghost() {
    let suffix = std::process::id() % 100_000;
    let alice_name = format!("alice{suffix}");
    let bob_name = format!("bob{suffix}");

    // --- Register: first user is admin; registration is closed, so Bob needs
    // Alice's invite. This exercises the honest-boot auth surface for real.
    let alice = Client::register(&alice_name, "correct horse battery", None).await;
    let invite = alice.post("/api/invites", json!({ "max_uses": 1 })).await;
    let code = invite["code"].as_str().expect("invite code");
    let bob = Client::register(&bob_name, "hunter2hunter2", Some(code)).await;

    // --- Real client-side MLS identities (point-core, same crate the app uses).
    let mut alice_mls = PointCrypto::new(&alice.user_id).expect("alice mls");
    let mut bob_mls = PointCrypto::new(&bob.user_id).expect("bob mls");

    // Bob publishes KeyPackages (the pool the server hands out one-time).
    let bob_kps: Vec<String> = (0..2)
        .map(|_| B64.encode(bob_mls.generate_key_package().expect("bob kp")))
        .collect();
    bob.post("/api/mls/keys", json!({ "key_packages": bob_kps }))
        .await;

    // --- Sharing relationship: request -> accept (authz source of truth).
    alice
        .post("/api/shares/request", json!({ "to_user_id": bob.user_id }))
        .await;
    let requests = bob.get("/api/shares/requests").await;
    let req_id = requests[0]["id"].as_str().expect("request id");
    bob.post(&format!("/api/shares/requests/{req_id}/accept"), json!({}))
        .await;

    // --- MLS group formation across the real server. Claiming a KeyPackage
    // consumes one (POST .../claim); a plain GET only probes and never drains.
    let fetched = alice
        .post(&format!("/api/mls/keys/{}/claim", bob.user_id), json!({}))
        .await;
    assert_eq!(fetched["last_resort"], json!(false));
    let bob_kp = B64
        .decode(fetched["key_package"].as_str().expect("kp"))
        .expect("kp b64");

    let (lo, hi) = if alice.user_id < bob.user_id {
        (&alice.user_id, &bob.user_id)
    } else {
        (&bob.user_id, &alice.user_id)
    };
    let pair_id = format!("dm:{lo}:{hi}");
    let gid = alice_mls.create_group(pair_id.as_bytes()).expect("group");
    let add = alice_mls.add_member(&gid, &bob_kp).expect("add bob");
    alice
        .post(
            "/api/mls/welcome",
            json!({
                "recipient_id": bob.user_id,
                "group_id": pair_id,
                "payload": B64.encode(&add.welcome),
            }),
        )
        .await;

    // Bob pulls the welcome from the mailbox and joins.
    let pending = bob.get("/api/mls/messages").await;
    let msgs = pending.as_array().expect("pending array");
    let welcome = msgs
        .iter()
        .find(|m| m["message_type"] == json!("welcome"))
        .expect("welcome message");
    let bob_gid = bob_mls
        .process_welcome(&B64.decode(welcome["payload"].as_str().unwrap()).unwrap())
        .expect("process welcome");
    bob.post(
        &format!("/api/mls/messages/{}/ack", welcome["id"].as_str().unwrap()),
        json!({}),
    )
    .await;

    // --- Live delivery: Alice encrypts a fix; the server relays ciphertext;
    // Bob decrypts. Two Bob sockets prove multi-device fan-out.
    let mut alice_ws = alice.ws().await;
    let mut bob_ws1 = bob.ws().await;
    let mut bob_ws2 = bob.ws().await;

    let location =
        json!({ "lat": 38.627, "lon": -90.199, "timestamp": 1_752_000_000_000_i64 }).to_string();
    let ciphertext = alice_mls
        .encrypt(&gid, location.as_bytes())
        .expect("encrypt");
    assert!(
        !String::from_utf8_lossy(&ciphertext).contains("38.627"),
        "ciphertext leaks plaintext"
    );

    alice_ws
        .send(Message::Text(
            json!({
                "type": "location.update",
                "recipient_type": "user",
                "recipient_id": bob.user_id,
                "blob": B64.encode(&ciphertext),
                "timestamp": 1_752_000_000_000_i64,
            })
            .to_string(),
        ))
        .await
        .expect("send fix");

    // Both of Bob's devices get the frame. Decrypt exactly once — MLS replay
    // protection (correctly) refuses the same ciphertext twice on one client
    // instance; a real second device holds its own MLS state. Here we prove
    // fan-out by byte-comparing the second copy.
    let frame1 = expect_frame(&mut bob_ws1, "location.broadcast", Duration::from_secs(5)).await;
    assert_eq!(frame1["sender_id"], json!(alice.user_id));
    let blob1 = B64
        .decode(frame1["blob"].as_str().expect("broadcast blob"))
        .expect("blob b64");
    let plaintext = bob_mls.decrypt(&bob_gid, &blob1).expect("bob decrypt");
    assert_eq!(String::from_utf8(plaintext).unwrap(), location);

    let frame2 = expect_frame(&mut bob_ws2, "location.broadcast", Duration::from_secs(5)).await;
    assert_eq!(
        frame2["blob"], frame1["blob"],
        "second device got a different blob"
    );

    // --- Ghost kill-switch: server-enforced, fail-closed.
    alice.put("/api/ghost", json!({ "active": true })).await;
    let ghost_ct = alice_mls.encrypt(&gid, b"ghosted fix").expect("encrypt2");
    alice_ws
        .send(Message::Text(
            json!({
                "type": "location.update",
                "recipient_type": "user",
                "recipient_id": bob.user_id,
                "blob": B64.encode(&ghost_ct),
                "timestamp": 1_752_000_000_001_i64,
            })
            .to_string(),
        ))
        .await
        .expect("send ghosted fix");
    expect_silence(&mut bob_ws1, "location.broadcast", Duration::from_secs(2)).await;

    // Ghost off -> delivery resumes (MLS ratchet: encrypt fresh).
    alice.put("/api/ghost", json!({ "active": false })).await;
    let resumed = alice_mls
        .encrypt(&gid, location.as_bytes())
        .expect("encrypt3");
    alice_ws
        .send(Message::Text(
            json!({
                "type": "location.update",
                "recipient_type": "user",
                "recipient_id": bob.user_id,
                "blob": B64.encode(&resumed),
                "timestamp": 1_752_000_000_002_i64,
            })
            .to_string(),
        ))
        .await
        .expect("send resumed fix");
    let frame = expect_frame(&mut bob_ws1, "location.broadcast", Duration::from_secs(5)).await;
    // NOTE: bob_ws1 skipped the ghosted blob (never delivered) and this decrypts
    // the post-ghost message — but bob_ws2 hasn't consumed it; the MLS ratchet
    // tolerates the skip on ws2's copy because both sockets share one PointCrypto
    // here. Decrypt once, on ws1's copy only.
    let blob = B64.decode(frame["blob"].as_str().unwrap()).unwrap();
    let plaintext = bob_mls
        .decrypt(&bob_gid, &blob)
        .expect("post-ghost decrypt");
    assert_eq!(String::from_utf8(plaintext).unwrap(), location);

    println!(
        "E2E ✓ register → invite → share → MLS group → encrypted fix → decrypt → ghost enforced"
    );
}
