//! Wave-C integration tests: the MLS delivery service (KeyPackage consumption
//! per D-007, welcome/commit mailbox) over the oneshot harness, and the live
//! WebSocket path against a real axum server on an ephemeral port.

use std::time::Duration;

use axum::http::StatusCode;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use uuid::Uuid;

use super::tests::{app, register, send, token_of, DOMAIN};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

fn uid(name: &str) -> String {
    format!("{name}@{DOMAIN}")
}

fn b64(bytes: &[u8]) -> String {
    BASE64.encode(bytes)
}

/// Register via the API (fresh router per call so the register rate limit
/// never interferes) and return the bearer token.
async fn user(pool: &PgPool, name: &str) -> String {
    let (status, v) = register(&app(pool, true), name, "password1", None).await;
    assert_eq!(status, StatusCode::OK, "register {name}: {v}");
    token_of(&v)
}

async fn seed_share(pool: &PgPool, a: &str, b: &str) {
    let (lo, hi) = if a < b { (a, b) } else { (b, a) };
    sqlx::query("INSERT INTO user_shares (user_a, user_b) VALUES ($1, $2)")
        .bind(lo)
        .bind(hi)
        .execute(pool)
        .await
        .unwrap();
}

async fn seed_group(pool: &PgPool, owner: &str, members: &[&str]) -> Uuid {
    let (gid,): (Uuid,) =
        sqlx::query_as("INSERT INTO groups (name, owner_id) VALUES ('g', $1) RETURNING id")
            .bind(owner)
            .fetch_one(pool)
            .await
            .unwrap();
    for m in std::iter::once(&owner).chain(members) {
        sqlx::query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)")
            .bind(gid)
            .bind(m)
            .execute(pool)
            .await
            .unwrap();
    }
    gid
}

async fn count(pool: &PgPool, sql: &str) -> i64 {
    let (n,): (i64,) = sqlx::query_as(sql).fetch_one(pool).await.unwrap();
    n
}

// ---------------------------------------------------------------------------
// MLS: KeyPackages
// ---------------------------------------------------------------------------

async fn upload_keys(
    app: &axum::Router,
    token: &str,
    packages: &[&str],
    last_resort: Option<&str>,
) -> (StatusCode, Value) {
    let packages: Vec<String> = packages.iter().map(|p| b64(p.as_bytes())).collect();
    let mut body = json!({ "key_packages": packages });
    if let Some(lr) = last_resort {
        body["last_resort"] = json!(b64(lr.as_bytes()));
    }
    send(app, "POST", "/api/mls/keys", Some(token), Some(body)).await
}

#[sqlx::test]
async fn key_package_fetch_consumes_one_time(pool: PgPool) {
    let app = app(&pool, true);
    let alice = user(&pool, "alice").await;
    let bob = user(&pool, "bob").await;
    seed_share(&pool, &uid("alice"), &uid("bob")).await;

    let (status, v) = upload_keys(&app, &alice, &["kp-0", "kp-1", "kp-2"], Some("kp-lr")).await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["stored"], 3);
    assert_eq!(v["unconsumed"], 3);
    assert_eq!(v["has_last_resort"], true);

    let path = format!("/api/mls/keys/{}", uid("alice"));
    let (status, first) = send(&app, "GET", &path, Some(&bob), None).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["last_resort"], false);
    assert_eq!(first["remaining"], 2);

    // Second fetch: a DIFFERENT package — the first was consumed, never re-served.
    let (status, second) = send(&app, "GET", &path, Some(&bob), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(second["last_resort"], false);
    assert_eq!(second["remaining"], 1);
    assert_ne!(
        first["key_package"], second["key_package"],
        "a consumed package must never be served twice"
    );

    // The owner's replenish view agrees.
    let (status, c) = send(&app, "GET", "/api/mls/keys/count", Some(&alice), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(c["count"], 1);
    assert_eq!(c["has_last_resort"], true);
}

#[sqlx::test]
async fn key_package_exhaustion_falls_back_to_last_resort_unconsumed(pool: PgPool) {
    let app = app(&pool, true);
    let alice = user(&pool, "alice").await;
    let bob = user(&pool, "bob").await;
    seed_share(&pool, &uid("alice"), &uid("bob")).await;

    let (status, _) = upload_keys(&app, &alice, &["kp-only"], Some("kp-lr")).await;
    assert_eq!(status, StatusCode::OK);

    let path = format!("/api/mls/keys/{}", uid("alice"));
    let (_, v) = send(&app, "GET", &path, Some(&bob), None).await;
    assert_eq!(v["last_resort"], false);
    assert_eq!(v["remaining"], 0);

    // Pool dry: the last-resort package is served, repeatedly, never consumed.
    for _ in 0..2 {
        let (status, v) = send(&app, "GET", &path, Some(&bob), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(v["last_resort"], true);
        assert_eq!(v["key_package"], b64(b"kp-lr"));
    }
    let unconsumed_lr = count(
        &pool,
        "SELECT COUNT(*) FROM key_packages WHERE is_last_resort AND consumed_at IS NULL",
    )
    .await;
    assert_eq!(unconsumed_lr, 1);

    // A user with no packages at all is a 404 even for an entitled fetcher.
    let _carol = user(&pool, "carol").await;
    seed_share(&pool, &uid("bob"), &uid("carol")).await;
    let (status, _) = send(
        &app,
        "GET",
        &format!("/api/mls/keys/{}", uid("carol")),
        Some(&bob),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[sqlx::test]
async fn key_package_fetch_requires_relationship(pool: PgPool) {
    let app = app(&pool, true);
    let alice = user(&pool, "alice").await;
    let carol = user(&pool, "carol").await;
    let (status, _) = upload_keys(&app, &alice, &["kp-0"], None).await;
    assert_eq!(status, StatusCode::OK);

    // No relationship -> 404, indistinguishable from "no such user".
    let (status, _) = send(
        &app,
        "GET",
        &format!("/api/mls/keys/{}", uid("alice")),
        Some(&carol),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = send(
        &app,
        "GET",
        &format!("/api/mls/keys/{}", uid("nobody")),
        Some(&carol),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Nothing was consumed by the denied fetches.
    let n = count(
        &pool,
        "SELECT COUNT(*) FROM key_packages WHERE consumed_at IS NULL",
    )
    .await;
    assert_eq!(n, 1);
}

#[sqlx::test]
async fn key_package_upload_limits(pool: PgPool) {
    let app = app(&pool, true);
    let alice = user(&pool, "alice").await;

    // More than 5 per request.
    let six: Vec<&str> = vec!["a", "b", "c", "d", "e", "f"];
    let (status, _) = upload_keys(&app, &alice, &six, None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Oversized (decoded > 2KB).
    let big = "x".repeat(2049);
    let (status, _) = upload_keys(&app, &alice, &[big.as_str()], None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Nothing at all / invalid base64.
    let (status, _) = send(
        &app,
        "POST",
        "/api/mls/keys",
        Some(&alice),
        Some(json!({ "key_packages": [] })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = send(
        &app,
        "POST",
        "/api/mls/keys",
        Some(&alice),
        Some(json!({ "key_packages": ["not base64!!"] })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Pool cap: 4 uploads of 5 fill the 20; the 21st package is rejected.
    for batch in 0..4 {
        let names: Vec<String> = (0..5).map(|i| format!("kp-{batch}-{i}")).collect();
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        let (status, v) = upload_keys(&app, &alice, &refs, None).await;
        assert_eq!(status, StatusCode::OK, "batch {batch}: {v}");
    }
    let (status, _) = upload_keys(&app, &alice, &["kp-overflow"], None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let n = count(&pool, "SELECT COUNT(*) FROM key_packages").await;
    assert_eq!(n, 20);

    // The last-resort package is exempt from the pool cap and upserts.
    for lr in ["lr-1", "lr-2"] {
        let (status, v) = upload_keys(&app, &alice, &[], Some(lr)).await;
        assert_eq!(status, StatusCode::OK, "{v}");
    }
    let lr_rows: Vec<(Vec<u8>,)> =
        sqlx::query_as("SELECT key_package FROM key_packages WHERE is_last_resort")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(lr_rows.len(), 1, "exactly ONE last-resort package");
    assert_eq!(lr_rows[0].0, b"lr-2", "re-upload replaces it");
}

// ---------------------------------------------------------------------------
// MLS: welcome / commit / ack
// ---------------------------------------------------------------------------

#[sqlx::test]
async fn welcome_and_ack_flow(pool: PgPool) {
    let app = app(&pool, true);
    let alice = user(&pool, "alice").await;
    let bob = user(&pool, "bob").await;
    let carol = user(&pool, "carol").await;
    seed_share(&pool, &uid("alice"), &uid("bob")).await;

    // No relationship (carol) and unknown recipient: the same 404.
    for recipient in [uid("carol"), uid("nobody")] {
        let (status, _) = send(
            &app,
            "POST",
            "/api/mls/welcome",
            Some(&alice),
            Some(json!({ "recipient_id": recipient, "group_id": "g1", "payload": b64(b"w") })),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    let (status, v) = send(
        &app,
        "POST",
        "/api/mls/welcome",
        Some(&alice),
        Some(json!({
            "recipient_id": uid("bob"),
            "group_id": "g1",
            "payload": b64(b"welcome-ciphertext"),
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    let id = v["id"].as_str().unwrap().to_string();

    // Bob's mailbox has it, payload intact.
    let (status, msgs) = send(&app, "GET", "/api/mls/messages", Some(&bob), None).await;
    assert_eq!(status, StatusCode::OK);
    let msgs = msgs.as_array().unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0]["id"], id.as_str());
    assert_eq!(msgs[0]["message_type"], "welcome");
    assert_eq!(msgs[0]["group_id"], "g1");
    assert_eq!(msgs[0]["sender_id"], uid("alice"));
    assert_eq!(msgs[0]["payload"], b64(b"welcome-ciphertext"));

    // Only the recipient can ack.
    let ack_path = format!("/api/mls/messages/{id}/ack");
    let (status, _) = send(&app, "POST", &ack_path, Some(&carol), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = send(&app, "POST", &ack_path, Some(&bob), None).await;
    assert_eq!(status, StatusCode::OK);
    let (_, msgs) = send(&app, "GET", "/api/mls/messages", Some(&bob), None).await;
    assert!(msgs.as_array().unwrap().is_empty(), "acked = gone");
}

#[sqlx::test]
async fn commit_fans_out_to_group_and_explicit_recipients(pool: PgPool) {
    let app = app(&pool, true);
    let alice = user(&pool, "alice").await;
    let bob = user(&pool, "bob").await;
    let _carol = user(&pool, "carol").await;
    let dave = user(&pool, "dave").await;
    let gid = seed_group(&pool, &uid("alice"), &[&uid("bob"), &uid("carol")]).await;

    // Group fan-out: every current member except the sender.
    let (status, v) = send(
        &app,
        "POST",
        "/api/mls/commit",
        Some(&alice),
        Some(json!({ "group_id": gid, "payload": b64(b"commit-1") })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["delivered"], 2);
    let (_, msgs) = send(&app, "GET", "/api/mls/messages", Some(&bob), None).await;
    assert_eq!(msgs.as_array().unwrap().len(), 1);
    assert_eq!(msgs[0]["message_type"], "commit");
    assert_eq!(msgs[0]["payload"], b64(b"commit-1"));

    // Non-members can't commit into (or probe) the group.
    let (status, _) = send(
        &app,
        "POST",
        "/api/mls/commit",
        Some(&dave),
        Some(json!({ "group_id": gid, "payload": b64(b"x") })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // A group id that is no real group is a 400.
    let (status, _) = send(
        &app,
        "POST",
        "/api/mls/commit",
        Some(&alice),
        Some(json!({ "group_id": Uuid::new_v4(), "payload": b64(b"x") })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = send(
        &app,
        "POST",
        "/api/mls/commit",
        Some(&alice),
        Some(json!({ "group_id": "dm-not-a-uuid", "payload": b64(b"x") })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Explicit recipients (pairwise DM ids): each gated by the relationship.
    seed_share(&pool, &uid("alice"), &uid("dave")).await;
    let (status, v) = send(
        &app,
        "POST",
        "/api/mls/commit",
        Some(&alice),
        Some(json!({
            "group_id": "dm-alice-dave",
            "payload": b64(b"commit-2"),
            "recipient_ids": [uid("dave")],
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["delivered"], 1);
    let (_, msgs) = send(&app, "GET", "/api/mls/messages", Some(&dave), None).await;
    assert_eq!(msgs.as_array().unwrap().len(), 1);

    // One unrelated recipient poisons the whole request (fail closed, no
    // partial commits that would desync the MLS group).
    let erin = user(&pool, "erin").await;
    let _ = erin;
    let (status, _) = send(
        &app,
        "POST",
        "/api/mls/commit",
        Some(&alice),
        Some(json!({
            "group_id": "dm-alice-erin",
            "payload": b64(b"commit-3"),
            "recipient_ids": [uid("dave"), uid("erin")],
        })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let n = count(
        &pool,
        "SELECT COUNT(*) FROM mls_messages WHERE group_id = 'dm-alice-erin'",
    )
    .await;
    assert_eq!(n, 0, "nothing delivered from a refused commit");
}

// ---------------------------------------------------------------------------
// WebSocket harness
// ---------------------------------------------------------------------------

/// Real axum server on an ephemeral port; all WS connections in a test share
/// its hub. Returns the ws:// URL.
async fn spawn_ws_server(pool: &PgPool) -> String {
    let router = app(pool, true);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    format!("ws://{addr}/ws")
}

/// Next JSON frame within `ms`, skipping transport frames. None = closed or
/// nothing arrived in time.
async fn recv_frame(ws: &mut Ws, ms: u64) -> Option<Value> {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(ms);
    loop {
        let msg = tokio::time::timeout_at(deadline, ws.next()).await.ok()??;
        match msg {
            Ok(Message::Text(t)) => return serde_json::from_str(&t).ok(),
            Ok(Message::Close(_)) => return None,
            Ok(_) => continue,
            Err(_) => return None,
        }
    }
}

/// Read frames until one of `typ` arrives (skipping unrelated broadcasts).
async fn expect_frame(ws: &mut Ws, typ: &str, ms: u64) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(ms);
    loop {
        let remaining = deadline
            .checked_duration_since(tokio::time::Instant::now())
            .unwrap_or_else(|| panic!("no {typ:?} frame within {ms}ms"));
        match recv_frame(ws, remaining.as_millis() as u64).await {
            Some(f) if f["type"] == typ => return f,
            Some(_) => continue,
            None => panic!("no {typ:?} frame within {ms}ms"),
        }
    }
}

async fn ws_connect_auth(url: &str, token: &str, expect_uid: &str) -> Ws {
    let (mut ws, _) = connect_async(url).await.expect("ws connect");
    ws.send(Message::Text(
        json!({ "type": "auth", "token": token }).to_string(),
    ))
    .await
    .unwrap();
    let frame = recv_frame(&mut ws, 2000).await.expect("auth.ok frame");
    assert_eq!(frame["type"], "auth.ok", "{frame}");
    assert_eq!(frame["user_id"], expect_uid);
    ws
}

async fn ws_send(ws: &mut Ws, frame: Value) {
    ws.send(Message::Text(frame.to_string())).await.unwrap();
}

// ---------------------------------------------------------------------------
// WS: auth
// ---------------------------------------------------------------------------

#[sqlx::test]
async fn ws_auth_success_broadcasts_presence_online(pool: PgPool) {
    let url = spawn_ws_server(&pool).await;
    let alice = user(&pool, "alice").await;
    let bob = user(&pool, "bob").await;
    seed_share(&pool, &uid("alice"), &uid("bob")).await;

    let mut bob_ws = ws_connect_auth(&url, &bob, &uid("bob")).await;
    let _alice_ws = ws_connect_auth(&url, &alice, &uid("alice")).await;

    let presence = expect_frame(&mut bob_ws, "presence.update", 2000).await;
    assert_eq!(presence["user_id"], uid("alice"));
    assert_eq!(presence["online"], true);
}

#[sqlx::test]
async fn ws_auth_bad_token_closes_quietly(pool: PgPool) {
    let url = spawn_ws_server(&pool).await;
    let (mut ws, _) = connect_async(url.as_str()).await.unwrap();
    ws.send(Message::Text(
        json!({ "type": "auth", "token": "garbage" }).to_string(),
    ))
    .await
    .unwrap();
    // No auth.ok, no error detail: the socket just closes.
    assert!(recv_frame(&mut ws, 2000).await.is_none());
}

#[sqlx::test]
async fn ws_auth_timeout_closes(pool: PgPool) {
    let url = spawn_ws_server(&pool).await;
    let (mut ws, _) = connect_async(url.as_str()).await.unwrap();
    // Send nothing: the server must hang up on its own (test AUTH_TIMEOUT is
    // 500ms; prod is 5s).
    let start = std::time::Instant::now();
    let closed = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match ws.next().await {
                None | Some(Ok(Message::Close(_))) | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    assert!(closed.is_ok(), "server never closed the unauthed socket");
    assert!(
        start.elapsed() >= Duration::from_millis(400),
        "closed early"
    );
}

#[sqlx::test]
async fn ws_origin_guard(pool: PgPool) {
    let url = spawn_ws_server(&pool).await;

    // Foreign browser origin: refused before upgrade.
    let mut req = url.as_str().into_client_request().unwrap();
    req.headers_mut()
        .insert("Origin", HeaderValue::from_static("https://evil.example"));
    match connect_async(req).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(resp)) => {
            assert_eq!(resp.status(), StatusCode::FORBIDDEN)
        }
        other => panic!("expected 403 handshake rejection, got {other:?}"),
    }

    // Own domain and dev origins pass (missing Origin is covered by every
    // other test in this file).
    for origin in ["https://test.example", "http://localhost:3000"] {
        let mut req = url.as_str().into_client_request().unwrap();
        req.headers_mut()
            .insert("Origin", HeaderValue::from_str(origin).unwrap());
        connect_async(req)
            .await
            .unwrap_or_else(|e| panic!("origin {origin} should be allowed: {e:?}"));
    }
}

// ---------------------------------------------------------------------------
// WS: location delivery
// ---------------------------------------------------------------------------

#[sqlx::test]
async fn ws_location_update_delivers_ciphertext_intact(pool: PgPool) {
    let url = spawn_ws_server(&pool).await;
    let alice = user(&pool, "alice").await;
    let bob = user(&pool, "bob").await;
    seed_share(&pool, &uid("alice"), &uid("bob")).await;

    let mut bob_ws = ws_connect_auth(&url, &bob, &uid("bob")).await;
    let mut alice_ws = ws_connect_auth(&url, &alice, &uid("alice")).await;

    let blob = b64(b"opaque-mls-ciphertext-\x00\x01\x02");
    ws_send(
        &mut alice_ws,
        json!({
            "type": "location.update",
            "recipient_type": "user",
            "recipient_id": uid("bob"),
            "blob": blob,
            "timestamp": 1_720_000_000_000_i64,
        }),
    )
    .await;

    let frame = expect_frame(&mut bob_ws, "location.broadcast", 2000).await;
    assert_eq!(frame["sender_id"], uid("alice"));
    assert_eq!(frame["blob"], blob, "ciphertext must survive end-to-end");
    assert_eq!(frame["timestamp"], 1_720_000_000_000_i64);

    // Persisted: one live fix + one history row, bytes intact.
    let (live_blob, ts): (Vec<u8>, i64) =
        sqlx::query_as("SELECT encrypted_blob, client_timestamp FROM location_updates")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(live_blob, b"opaque-mls-ciphertext-\x00\x01\x02");
    assert_eq!(ts, 1_720_000_000_000_i64);
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM location_history").await,
        1
    );

    // A second fix REPLACES the live row for this audience (history grows).
    ws_send(
        &mut alice_ws,
        json!({
            "type": "location.update",
            "recipient_type": "user",
            "recipient_id": uid("bob"),
            "blob": b64(b"fix-2"),
            "timestamp": 1_720_000_000_001_i64,
        }),
    )
    .await;
    expect_frame(&mut bob_ws, "location.broadcast", 2000).await;
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM location_updates").await,
        1
    );
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM location_history").await,
        2
    );
}

#[sqlx::test]
async fn ws_location_update_to_non_sharing_user_is_silently_dropped(pool: PgPool) {
    let url = spawn_ws_server(&pool).await;
    let alice = user(&pool, "alice").await;
    let bob = user(&pool, "bob").await;

    let mut bob_ws = ws_connect_auth(&url, &bob, &uid("bob")).await;
    let mut alice_ws = ws_connect_auth(&url, &alice, &uid("alice")).await;

    ws_send(
        &mut alice_ws,
        json!({
            "type": "location.update",
            "recipient_type": "user",
            "recipient_id": uid("bob"),
            "blob": b64(b"should-not-arrive"),
            "timestamp": 1,
        }),
    )
    .await;

    // Silent drop: nothing for bob, no error oracle for alice, nothing stored.
    assert!(recv_frame(&mut bob_ws, 300).await.is_none());
    assert!(recv_frame(&mut alice_ws, 100).await.is_none());
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM location_updates").await,
        0
    );
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM location_history").await,
        0
    );
}

#[sqlx::test]
async fn ws_ghost_drops_location_updates(pool: PgPool) {
    let url = spawn_ws_server(&pool).await;
    let alice = user(&pool, "alice").await;
    let bob = user(&pool, "bob").await;
    seed_share(&pool, &uid("alice"), &uid("bob")).await;
    sqlx::query("UPDATE users SET ghost_active = TRUE WHERE id = $1")
        .bind(uid("alice"))
        .execute(&pool)
        .await
        .unwrap();

    let mut bob_ws = ws_connect_auth(&url, &bob, &uid("bob")).await;
    let mut alice_ws = ws_connect_auth(&url, &alice, &uid("alice")).await;

    ws_send(
        &mut alice_ws,
        json!({
            "type": "location.update",
            "recipient_type": "user",
            "recipient_id": uid("bob"),
            "blob": b64(b"ghosted"),
            "timestamp": 1,
        }),
    )
    .await;

    // Ghost wins: no delivery, and no presence leaked on connect either.
    assert!(recv_frame(&mut bob_ws, 300).await.is_none());
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM location_updates").await,
        0
    );
}

#[sqlx::test]
async fn ws_group_fanout_respects_sharing_flag(pool: PgPool) {
    let url = spawn_ws_server(&pool).await;
    let alice = user(&pool, "alice").await;
    let bob = user(&pool, "bob").await;
    let gid = seed_group(&pool, &uid("alice"), &[&uid("bob")]).await;

    let mut bob_ws = ws_connect_auth(&url, &bob, &uid("bob")).await;
    let mut alice_ws = ws_connect_auth(&url, &alice, &uid("alice")).await;

    let fix = |blob: &str| {
        json!({
            "type": "location.update",
            "recipient_type": "group",
            "recipient_id": gid,
            "blob": b64(blob.as_bytes()),
            "timestamp": 1,
        })
    };

    // sharing=true (default): the fix fans out to the co-member.
    ws_send(&mut alice_ws, fix("visible")).await;
    let frame = expect_frame(&mut bob_ws, "location.broadcast", 2000).await;
    assert_eq!(frame["sender_id"], uid("alice"));
    assert_eq!(frame["recipient_id"], gid.to_string());

    // sharing=false: the member opted out of broadcasting — silent drop.
    sqlx::query("UPDATE group_members SET sharing = FALSE WHERE group_id = $1 AND user_id = $2")
        .bind(gid)
        .bind(uid("alice"))
        .execute(&pool)
        .await
        .unwrap();
    ws_send(&mut alice_ws, fix("hidden")).await;
    assert!(
        recv_frame(&mut bob_ws, 400).await.is_none(),
        "sharing=false member must not reach the group"
    );
}

#[sqlx::test]
async fn ws_batch_update_stores_history_broadcasts_newest_only(pool: PgPool) {
    let url = spawn_ws_server(&pool).await;
    let alice = user(&pool, "alice").await;
    let bob = user(&pool, "bob").await;
    seed_share(&pool, &uid("alice"), &uid("bob")).await;
    let _carol = user(&pool, "carol").await; // no share with alice

    let mut bob_ws = ws_connect_auth(&url, &bob, &uid("bob")).await;
    let mut alice_ws = ws_connect_auth(&url, &alice, &uid("alice")).await;

    let item = |to: &str, blob: &str, ts: i64| {
        json!({
            "recipient_type": "user",
            "recipient_id": to,
            "blob": b64(blob.as_bytes()),
            "timestamp": ts,
        })
    };
    ws_send(
        &mut alice_ws,
        json!({
            "type": "location.batch_update",
            "blobs": [
                item(&uid("bob"), "fix-old", 1000),
                item(&uid("bob"), "fix-newest", 3000),
                item(&uid("bob"), "fix-mid", 2000),
                item(&uid("carol"), "denied", 4000),
            ],
        }),
    )
    .await;

    // Only the newest fix per audience hits the wire...
    let frame = expect_frame(&mut bob_ws, "location.broadcast", 2000).await;
    assert_eq!(frame["blob"], b64(b"fix-newest"));
    assert_eq!(frame["timestamp"], 3000);
    assert!(
        recv_frame(&mut bob_ws, 300).await.is_none(),
        "older batch fixes must not be broadcast"
    );

    // ...and the live table, while history keeps every allowed fix. The
    // denied audience (carol) left no trace anywhere.
    let (live_ts,): (i64,) = sqlx::query_as("SELECT client_timestamp FROM location_updates")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(live_ts, 3000);
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM location_history").await,
        3
    );
    assert_eq!(
        count(
            &pool,
            "SELECT COUNT(*) FROM location_history WHERE recipient_id LIKE 'carol%'",
        )
        .await,
        0
    );
}

// ---------------------------------------------------------------------------
// WS: nudge, presence, protocol errors
// ---------------------------------------------------------------------------

#[sqlx::test]
async fn ws_nudge_relayed_only_when_viewer_can_see_target(pool: PgPool) {
    let url = spawn_ws_server(&pool).await;
    let alice = user(&pool, "alice").await;
    let bob = user(&pool, "bob").await;
    let carol = user(&pool, "carol").await;
    seed_share(&pool, &uid("alice"), &uid("bob")).await;

    let mut bob_ws = ws_connect_auth(&url, &bob, &uid("bob")).await;
    let mut alice_ws = ws_connect_auth(&url, &alice, &uid("alice")).await;
    let mut carol_ws = ws_connect_auth(&url, &carol, &uid("carol")).await;

    // Unrelated viewer: silent drop.
    ws_send(
        &mut carol_ws,
        json!({ "type": "location.nudge", "target_user_id": uid("bob") }),
    )
    .await;
    // Entitled viewer: relayed.
    ws_send(
        &mut alice_ws,
        json!({ "type": "location.nudge", "target_user_id": uid("bob") }),
    )
    .await;

    let frame = expect_frame(&mut bob_ws, "location.nudge", 2000).await;
    assert_eq!(frame["from"], uid("alice"));
    assert!(
        recv_frame(&mut bob_ws, 300).await.is_none(),
        "carol's nudge must never arrive"
    );
}

#[sqlx::test]
async fn ws_presence_update_reaches_shares_and_group_members(pool: PgPool) {
    let url = spawn_ws_server(&pool).await;
    let alice = user(&pool, "alice").await;
    let bob = user(&pool, "bob").await;
    let carol = user(&pool, "carol").await;
    seed_share(&pool, &uid("alice"), &uid("bob")).await;
    seed_group(&pool, &uid("alice"), &[&uid("carol")]).await;

    let mut bob_ws = ws_connect_auth(&url, &bob, &uid("bob")).await;
    let mut carol_ws = ws_connect_auth(&url, &carol, &uid("carol")).await;
    let mut alice_ws = ws_connect_auth(&url, &alice, &uid("alice")).await;

    ws_send(
        &mut alice_ws,
        json!({ "type": "presence.update", "battery": 42, "activity": "walking" }),
    )
    .await;

    // Share partner AND group co-member both see it.
    for ws in [&mut bob_ws, &mut carol_ws] {
        let frame = loop {
            let f = expect_frame(ws, "presence.update", 2000).await;
            if f["battery"] == 42 {
                break f; // skip the on-connect presence frames
            }
        };
        assert_eq!(frame["user_id"], uid("alice"));
        assert_eq!(frame["online"], true);
        assert_eq!(frame["activity"], "walking");
    }
}

#[sqlx::test]
async fn ws_unknown_type_errors_but_keeps_connection(pool: PgPool) {
    let url = spawn_ws_server(&pool).await;
    let alice = user(&pool, "alice").await;
    let mut ws = ws_connect_auth(&url, &alice, &uid("alice")).await;

    ws_send(&mut ws, json!({ "type": "bogus.frame" })).await;
    let frame = expect_frame(&mut ws, "error", 2000).await;
    assert_eq!(frame["error"], "unknown type");

    // Still connected and serving.
    ws_send(&mut ws, json!({ "type": "another.bogus" })).await;
    let frame = expect_frame(&mut ws, "error", 2000).await;
    assert_eq!(frame["error"], "unknown type");
}

#[sqlx::test]
async fn ws_nudge_rate_limited(pool: PgPool) {
    let url = spawn_ws_server(&pool).await;
    let alice = user(&pool, "alice").await;
    let _bob = user(&pool, "bob").await;
    seed_share(&pool, &uid("alice"), &uid("bob")).await;
    let mut alice_ws = ws_connect_auth(&url, &alice, &uid("alice")).await;

    // Limit is 10/min; 21 sends guarantee an over-limit frame even if a
    // 60s window boundary falls in the middle.
    for _ in 0..21 {
        ws_send(
            &mut alice_ws,
            json!({ "type": "location.nudge", "target_user_id": uid("bob") }),
        )
        .await;
    }
    let frame = expect_frame(&mut alice_ws, "error", 2000).await;
    assert_eq!(frame["error"], "rate limited");
}
