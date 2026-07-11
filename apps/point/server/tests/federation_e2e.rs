//! The honest cross-instance federation proof (M3): two full Point instances,
//! a user on each, driving a LIVE E2E share — cross-server MLS group, an
//! encrypted location fix relayed A→B, decrypted by the recipient — with both
//! servers only ever handling ciphertext. Uses real point-core MLS on the
//! client side and real REST + WS + signed S2S between the instances.
//!
//! Driven by tests/run-federation-e2e.sh (starts both instances). Standalone:
//!   FED_A_URL=... FED_B_URL=... FED_A_DOM=... FED_B_DOM=... \
//!     cargo test -p point-server --test federation_e2e -- --ignored --nocapture

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use futures::{SinkExt, StreamExt};
use point_core::PointCrypto;
use serde_json::{json, Value};
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
        assert!(
            res.status().is_success(),
            "register {username} failed: {}",
            res.text().await.unwrap_or_default()
        );
        let v: Value = res.json().await.unwrap();
        Client {
            http,
            base: base.to_string(),
            token: v["token"].as_str().unwrap().to_string(),
            user_id: v["user_id"].as_str().unwrap().to_string(),
        }
    }

    async fn post(&self, path: &str, body: Value) -> Value {
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
        assert!(status.is_success(), "POST {path} -> {status}: {text}");
        serde_json::from_str(&text).unwrap_or(Value::Null)
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
        let kps: Vec<String> = (0..3)
            .map(|_| B64.encode(mls.generate_key_package().unwrap()))
            .collect();
        self.post("/api/mls/keys", json!({ "key_packages": kps }))
            .await;
    }

    async fn ws(
        &self,
    ) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>
    {
        let url = format!("{}/ws", self.base.replacen("http", "ws", 1));
        let (mut sock, _) = tokio_tungstenite::connect_async(url).await.expect("ws");
        sock.send(Message::Text(
            json!({ "type": "auth", "token": self.token }).to_string(),
        ))
        .await
        .unwrap();
        // await auth.ok
        loop {
            if let Some(Ok(Message::Text(t))) = sock.next().await {
                let v: Value = serde_json::from_str(&t).unwrap();
                if v["type"] == json!("auth.ok") {
                    break;
                }
            }
        }
        sock
    }
}

#[tokio::test]
#[ignore = "needs two live instances; run via tests/run-federation-e2e.sh"]
async fn cross_instance_e2e_share() {
    let a_url = std::env::var("FED_A_URL").expect("FED_A_URL");
    let b_url = std::env::var("FED_B_URL").expect("FED_B_URL");

    // A user on each instance.
    let alice = Client::register(&a_url, "alice").await;
    let bob = Client::register(&b_url, "bob").await;

    let mut alice_mls = PointCrypto::new(&alice.user_id).unwrap();
    let mut bob_mls = PointCrypto::new(&bob.user_id).unwrap();
    alice.upload_kps(&mut alice_mls).await;
    bob.upload_kps(&mut bob_mls).await;

    // Stable per-identity keys for TOFU pinning (opaque to the server).
    let alice_key = B64.encode([1u8; 32]);
    let bob_key = B64.encode([2u8; 32]);

    // 1. Alice → share.request to bob@B (signed S2S via A). Creates the pending
    //    on BOTH instances.
    alice
        .post(
            "/api/federation/send",
            json!({
                "recipient": bob.user_id,
                "message_type": "share.request",
                "payload": { "identity_key": alice_key },
            }),
        )
        .await;

    // 2. Bob accepts locally on B, then → share.accept back to alice@A.
    let reqs = bob.get("/api/shares/requests").await;
    let req_id = reqs[0]["id"].as_str().expect("bob sees alice's request");
    bob.post(&format!("/api/shares/requests/{req_id}/accept"), json!({}))
        .await;
    bob.post(
        "/api/federation/send",
        json!({
            "recipient": alice.user_id,
            "message_type": "share.accept",
            "payload": { "identity_key": bob_key },
        }),
    )
    .await;

    // 3. Alice fetches Bob's KeyPackage from HIS home server over S2S.
    let kr = alice
        .post(
            "/api/federation/send",
            json!({
                "recipient": bob.user_id,
                "message_type": "mls.key_request",
                "payload": { "identity_key": alice_key },
            }),
        )
        .await;
    let bob_kp_b64 = kr["response"]["key_package"]
        .as_str()
        .expect("remote KP fetched");
    let bob_kp = B64.decode(bob_kp_b64).unwrap();
    assert_eq!(
        kr["response"]["last_resort"],
        json!(false),
        "pool consumed, not last-resort"
    );

    // 4. Alice forms the cross-server MLS group and adds Bob → Welcome.
    let gid = alice_mls
        .create_group(format!("fed:{}:{}", alice.user_id, bob.user_id).as_bytes())
        .unwrap();
    let add = alice_mls.add_member(&gid, &bob_kp).unwrap();
    alice
        .post(
            "/api/federation/send",
            json!({
                "recipient": bob.user_id,
                "message_type": "mls.welcome",
                "payload": {
                    "group_id": format!("fed:{}:{}", alice.user_id, bob.user_id),
                    "ciphertext": B64.encode(&add.welcome),
                },
            }),
        )
        .await;

    // 5. Bob pulls the Welcome from his mailbox and joins.
    let msgs = bob.get("/api/mls/messages").await;
    let welcome = msgs
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["message_type"] == json!("welcome"))
        .expect("bob got the cross-server Welcome");
    let bob_gid = bob_mls
        .process_welcome(&B64.decode(welcome["payload"].as_str().unwrap()).unwrap())
        .unwrap();

    // 6. Bob connects his WS; Alice encrypts a fix and relays it A→B.
    let mut bob_ws = bob.ws().await;
    let location =
        json!({ "lat": 38.627, "lon": -90.199, "timestamp": 1_752_000_000_000_i64 }).to_string();
    let ct = alice_mls.encrypt(&gid, location.as_bytes()).unwrap();
    assert!(
        !String::from_utf8_lossy(&ct).contains("38.627"),
        "ciphertext leaks plaintext"
    );

    alice
        .post(
            "/api/federation/send",
            json!({
                "recipient": bob.user_id,
                "message_type": "location.update",
                "payload": { "ciphertext": B64.encode(&ct), "timestamp": 1_752_000_000_000_i64 },
            }),
        )
        .await;

    // 7. Bob receives the relayed ciphertext over his WS and decrypts it.
    let received = tokio::time::timeout(Duration::from_secs(6), async {
        loop {
            if let Some(Ok(Message::Text(t))) = bob_ws.next().await {
                let v: Value = serde_json::from_str(&t).unwrap();
                if v["type"] == json!("location.broadcast") {
                    return v;
                }
            }
        }
    })
    .await
    .expect("bob received the cross-server broadcast");

    let blob = B64.decode(received["blob"].as_str().unwrap()).unwrap();
    let pt = bob_mls.decrypt(&bob_gid, &blob).unwrap();
    assert_eq!(
        String::from_utf8(pt).unwrap(),
        location,
        "cross-instance E2E decrypt"
    );

    println!("FEDERATION E2E ✓ alice@A shared E2E with bob@B; encrypted fix relayed + decrypted; servers saw only ciphertext");
}
