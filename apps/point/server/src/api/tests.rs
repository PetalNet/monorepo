//! Integration-style tests: the real router against a real, per-test Postgres
//! (`#[sqlx::test]` provisions a fresh migrated database for every test).
//! Requests go through `tower::ServiceExt::oneshot` — full extractor stack,
//! no network.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;

use crate::config::Config;
use crate::state::AppState;
use crate::ws::hub::Hub;

use super::auth::{map_oidc_username, sanitize_display_name, validate_username};

pub(super) const DOMAIN: &str = "test.example";

pub(super) fn test_state(pool: PgPool, open_registration: bool) -> AppState {
    AppState {
        pool,
        config: Arc::new(Config {
            database_url: String::new(),
            listen: "127.0.0.1:0".into(),
            jwt_secret: "unit-test-secret-0123456789abcdef".into(),
            domain: DOMAIN.into(),
            public_url: format!("https://{DOMAIN}"),
            federation_allow_private: false,
            open_registration,
            tiles_url: None,
            tile_upstream: None,
            trusted_proxy: false,
            glitchtip_dsn: None,
            oidc: None,
        }),
        hub: Arc::new(Hub::default()),
        // A fixed deterministic key is fine for tests: nothing here relies on
        // key persistence (the load/generate path is tested separately).
        server_signing_key: Arc::new(ed25519_dalek::SigningKey::from_bytes(&[42u8; 32])),
    }
}

/// Fresh router (fresh rate limiter) over shared DB state.
pub(super) fn app(pool: &PgPool, open_registration: bool) -> Router {
    super::router(test_state(pool.clone(), open_registration))
}

pub(super) async fn send(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(t) = token {
        builder = builder.header("authorization", format!("Bearer {t}"));
    }
    let request = match body {
        Some(v) => builder
            .header("content-type", "application/json")
            .body(Body::from(v.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value)
}

pub(super) async fn register(
    app: &Router,
    username: &str,
    password: &str,
    invite: Option<&str>,
) -> (StatusCode, Value) {
    let mut body = json!({ "username": username, "password": password });
    if let Some(code) = invite {
        body["invite_code"] = json!(code);
    }
    send(app, "POST", "/api/register", None, Some(body)).await
}

pub(super) async fn login(app: &Router, username: &str, password: &str) -> (StatusCode, Value) {
    send(
        app,
        "POST",
        "/api/login",
        None,
        Some(json!({ "username": username, "password": password })),
    )
    .await
}

pub(super) fn token_of(v: &Value) -> String {
    v["token"].as_str().expect("token in response").to_string()
}

// ---------------------------------------------------------------------------
// register / login
// ---------------------------------------------------------------------------

#[sqlx::test]
async fn register_login_roundtrip_first_user_is_admin(pool: PgPool) {
    // Registration closed: the very first user still gets in, as admin.
    let app = app(&pool, false);

    let (status, v) = register(&app, "alice", "password1", None).await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["user_id"], format!("alice@{DOMAIN}"));
    assert_eq!(v["display_name"], "alice");
    assert_eq!(v["is_admin"], true);
    let register_token = token_of(&v);

    // Registration created the person entity and the primary device too.
    let (entities,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM entities WHERE owner_id = $1 AND kind = 'person'")
            .bind(format!("alice@{DOMAIN}"))
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(entities, 1);
    let (device_name, is_primary): (String, bool) =
        sqlx::query_as("SELECT name, is_primary FROM devices WHERE user_id = $1")
            .bind(format!("alice@{DOMAIN}"))
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(device_name, "primary");
    assert!(is_primary);

    let (status, me) = send(&app, "GET", "/api/me", Some(&register_token), None).await;
    assert_eq!(status, StatusCode::OK, "{me}");
    assert_eq!(me["user_id"], format!("alice@{DOMAIN}"));
    assert_eq!(me["is_admin"], true);
    assert_eq!(me["ghost_active"], false);
    assert_eq!(me["visibility_mode"], "normal");

    // Login with the bare username and with the full user id.
    let (status, v) = login(&app, "alice", "password1").await;
    assert_eq!(status, StatusCode::OK, "{v}");
    let login_token = token_of(&v);
    let (status, _) = send(&app, "GET", "/api/me", Some(&login_token), None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = login(&app, &format!("alice@{DOMAIN}"), "password1").await;
    assert_eq!(status, StatusCode::OK);

    // No token -> 401.
    let (status, _) = send(&app, "GET", "/api/me", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[sqlx::test]
async fn second_user_requires_invite_when_registration_closed(pool: PgPool) {
    let app = app(&pool, false);

    let (status, admin) = register(&app, "admin", "password1", None).await;
    assert_eq!(status, StatusCode::OK);
    let admin_token = token_of(&admin);

    // No invite, wrong invite: both rejected.
    let (status, _) = register(&app, "bob", "password1", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = register(&app, "bob", "password1", Some("WRONGCOD")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, invite) = send(
        &app,
        "POST",
        "/api/invites",
        Some(&admin_token),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{invite}");
    let code = invite["code"].as_str().unwrap().to_string();
    assert_eq!(code.len(), 8);

    let (status, v) = register(&app, "bob", "password1", Some(&code)).await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["is_admin"], false);
}

#[sqlx::test]
async fn invite_exhaustion_and_expiry(pool: PgPool) {
    let app = app(&pool, false);

    let (_, admin) = register(&app, "admin", "password1", None).await;
    let admin_token = token_of(&admin);
    let (_, invite) = send(
        &app,
        "POST",
        "/api/invites",
        Some(&admin_token),
        Some(json!({ "max_uses": 1 })),
    )
    .await;
    let code = invite["code"].as_str().unwrap().to_string();

    // First use consumes the single-use invite; second is rejected.
    let (status, _) = register(&app, "bob", "password1", Some(&code)).await;
    assert_eq!(status, StatusCode::OK);
    let (status, v) = register(&app, "carol", "password1", Some(&code)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{v}");

    // Expired invites are rejected even with uses remaining.
    sqlx::query(
        "INSERT INTO invites (code, created_by, max_uses, expires_at)
         VALUES ('EXPIRED2', $1, 10, now() - interval '1 hour')",
    )
    .bind(format!("admin@{DOMAIN}"))
    .execute(&pool)
    .await
    .unwrap();
    let (status, _) = register(&app, "dave", "password1", Some("EXPIRED2")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[sqlx::test]
async fn bad_usernames_and_duplicates_rejected(pool: PgPool) {
    let long = "x".repeat(33);
    for bad in [
        "ab",
        long.as_str(),
        "has space",
        "bad!char",
        "dots.no",
        "emo😀ji",
    ] {
        // Fresh router per attempt so the register rate limit stays out of frame.
        let app = app(&pool, true);
        let (status, _) = register(&app, bad, "password1", None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "username {bad:?}");
    }

    // Uppercase is folded, not rejected.
    let (status, v) = register(&app(&pool, true), "AlIcE", "password1", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["user_id"], format!("alice@{DOMAIN}"));

    // Duplicate username: generic 400, indistinguishable from validation
    // failures (no account enumeration through register).
    let (status, v) = register(&app(&pool, true), "alice", "password2", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(v["error"], "registration failed");

    // Short and overlong passwords rejected.
    let (status, _) = register(&app(&pool, true), "shortpw", "short", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = register(&app(&pool, true), "longpw", &"p".repeat(129), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[sqlx::test]
async fn display_name_sanitization(pool: PgPool) {
    let app = app(&pool, true);

    // HTML-significant, control, zero-width, and bidi chars are stripped.
    let dirty = "<b>Eve&Co</b>\u{202E}\u{200B} evil\u{0007}";
    let (status, v) = send(
        &app,
        "POST",
        "/api/register",
        None,
        Some(json!({ "username": "eve", "password": "password1", "display_name": dirty })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["display_name"], "bEveCo/b evil");

    // Empty after sanitization -> falls back to the username.
    let (status, v) = send(
        &app,
        "POST",
        "/api/register",
        None,
        Some(json!({ "username": "fred", "password": "password1", "display_name": "\u{200B}<>&" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["display_name"], "fred");

    // Overlong names are truncated to 64 chars.
    let (status, v) = send(
        &app,
        "POST",
        "/api/register",
        None,
        Some(
            json!({ "username": "gina", "password": "password1", "display_name": "a".repeat(100) }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["display_name"], "a".repeat(64));
}

#[sqlx::test]
async fn login_rejects_wrong_password_unknown_federated_and_oidc_only(pool: PgPool) {
    let app = app(&pool, true);
    let (status, _) = register(&app, "alice", "password1", None).await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = login(&app, "alice", "wrong-password").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, _) = login(&app, "nobody", "password1").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Federated shadow: no local login, ever.
    sqlx::query(
        "INSERT INTO users (id, display_name, password_hash, is_federated)
         VALUES ('fed@remote.example', 'Fed', NULL, TRUE)",
    )
    .execute(&pool)
    .await
    .unwrap();
    let (status, _) = login(&app, "fed@remote.example", "password1").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // OIDC-only account (NULL hash, not federated): password login must fail.
    sqlx::query(
        "INSERT INTO users (id, display_name, password_hash)
         VALUES ('sso@test.example', 'SSO', NULL)",
    )
    .execute(&pool)
    .await
    .unwrap();
    let (status, _) = login(&app, "sso", "password1").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

// ---------------------------------------------------------------------------
// account
// ---------------------------------------------------------------------------

#[sqlx::test]
async fn password_change_revokes_old_tokens(pool: PgPool) {
    let app = app(&pool, true);
    let (_, v) = register(&app, "alice", "password1", None).await;
    let old_token = token_of(&v);

    // The revocation floor has one-second granularity (JWT iat); make sure the
    // change lands in a later second than the register.
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;

    // Wrong current password -> rejected, old token still fine.
    let (status, _) = send(
        &app,
        "PUT",
        "/api/account/password",
        Some(&old_token),
        Some(json!({ "current_password": "wrong", "new_password": "password2" })),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = send(&app, "GET", "/api/me", Some(&old_token), None).await;
    assert_eq!(status, StatusCode::OK);

    let (status, v) = send(
        &app,
        "PUT",
        "/api/account/password",
        Some(&old_token),
        Some(json!({ "current_password": "password1", "new_password": "password2" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    let fresh_token = token_of(&v);

    // Old token dead, fresh token (and a new login) alive.
    let (status, _) = send(&app, "GET", "/api/me", Some(&old_token), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = send(&app, "GET", "/api/me", Some(&fresh_token), None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = login(&app, "alice", "password1").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, v) = login(&app, "alice", "password2").await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(&app, "GET", "/api/me", Some(&token_of(&v)), None).await;
    assert_eq!(status, StatusCode::OK);
}

#[sqlx::test]
async fn account_deletion_requires_password_and_cascades(pool: PgPool) {
    let app = app(&pool, true);
    let (_, v) = register(&app, "alice", "password1", None).await;
    let token = token_of(&v);

    let (status, _) = send(
        &app,
        "DELETE",
        "/api/account",
        Some(&token),
        Some(json!({ "password": "wrong" })),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, _) = send(
        &app,
        "DELETE",
        "/api/account",
        Some(&token),
        Some(json!({ "password": "password1" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Token dead, rows (and cascaded entity/device rows) gone.
    let (status, _) = send(&app, "GET", "/api/me", Some(&token), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (users,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users")
        .fetch_one(&pool)
        .await
        .unwrap();
    let (entities,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM entities")
        .fetch_one(&pool)
        .await
        .unwrap();
    let (devices,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM devices")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!((users, entities, devices), (0, 0, 0));
}

#[sqlx::test]
async fn fcm_token_upserts(pool: PgPool) {
    let app = app(&pool, true);
    let (_, v) = register(&app, "alice", "password1", None).await;
    let token = token_of(&v);

    for _ in 0..2 {
        let (status, _) = send(
            &app,
            "POST",
            "/api/fcm/token",
            Some(&token),
            Some(json!({ "token": "fcm-token-1" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }
    let (rows,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM fcm_tokens")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rows, 1);

    let (status, _) = send(
        &app,
        "POST",
        "/api/fcm/token",
        Some(&token),
        Some(json!({ "token": "" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _) = send(
        &app,
        "POST",
        "/api/fcm/token",
        None,
        Some(json!({ "token": "fcm-token-1" })),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

// ---------------------------------------------------------------------------
// rate limiting
// ---------------------------------------------------------------------------

// The limiter's window is a FIXED 60s wall-clock bucket, so a slow CI run can
// straddle a boundary mid-test and split the attempts across two buckets
// (observed flake: the "(cap+1)th is 429" shape). Making 2*cap+1 attempts
// guarantees one bucket receives at least cap+1 of them, so at least one 429
// MUST appear — same property, no timing sensitivity.

#[sqlx::test]
async fn login_rate_limit_fires_within_a_window(pool: PgPool) {
    let app = app(&pool, true);
    let (status, _) = register(&app, "alice", "password1", None).await;
    assert_eq!(status, StatusCode::OK);

    // Per-username cap is 10/min: 21 wrong-password attempts must throttle.
    let mut throttled = false;
    for _ in 1..=21 {
        let (status, _) = login(&app, "alice", "wrong-password").await;
        match status {
            StatusCode::UNAUTHORIZED => {}
            StatusCode::TOO_MANY_REQUESTS => {
                throttled = true;
                break;
            }
            other => panic!("unexpected status {other}"),
        }
    }
    assert!(throttled, "21 bad logins never hit the per-user cap");

    // While throttled, the RIGHT password is throttled too: the window is per
    // username, not per outcome.
    let (status, _) = login(&app, "alice", "password1").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
}

#[sqlx::test]
async fn register_global_rate_limit_fires_within_a_window(pool: PgPool) {
    let app = app(&pool, true);
    // Global registration cap is 5/min: 11 attempts must throttle at least
    // one, whatever the bucket boundaries do.
    let mut throttled = false;
    for i in 1..=11 {
        let (status, _) = register(&app, &format!("user{i}"), "password1", None).await;
        match status {
            StatusCode::OK => {}
            StatusCode::TOO_MANY_REQUESTS => {
                throttled = true;
                break;
            }
            other => panic!("unexpected status {other}"),
        }
    }
    assert!(throttled, "11 registrations never hit the global cap");
}

// ---------------------------------------------------------------------------
// admin surface
// ---------------------------------------------------------------------------

#[sqlx::test]
async fn admin_endpoints_forbidden_for_non_admin(pool: PgPool) {
    let app = app(&pool, true);
    let (_, admin) = register(&app, "admin", "password1", None).await;
    let admin_token = token_of(&admin);
    let (_, bob) = register(&app, "bob", "password1", None).await;
    let bob_token = token_of(&bob);
    assert_eq!(bob["is_admin"], false);

    for (method, path, body) in [
        ("GET", "/api/invites", None),
        ("POST", "/api/invites", Some(json!({}))),
        (
            "DELETE",
            "/api/invites/00000000-0000-0000-0000-000000000000",
            None,
        ),
        ("GET", "/api/admin/info", None),
    ] {
        let (status, _) = send(&app, method, path, Some(&bob_token), body).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}");
    }

    // The admin can use all of them.
    let (status, info) = send(&app, "GET", "/api/admin/info", Some(&admin_token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(info["domain"], DOMAIN);
    assert_eq!(info["user_count"], 2);
    assert_eq!(info["open_registration"], true);
    assert_eq!(info["version"], env!("CARGO_PKG_VERSION"));

    let (status, invite) = send(
        &app,
        "POST",
        "/api/invites",
        Some(&admin_token),
        Some(json!({ "max_uses": 3, "expires_in_hours": 24 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{invite}");
    let invite_id = invite["id"].as_str().unwrap().to_string();

    let (status, list) = send(&app, "GET", "/api/invites", Some(&admin_token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["id"], invite_id.as_str());
    assert_eq!(list[0]["max_uses"], 3);

    let path = format!("/api/invites/{invite_id}");
    let (status, _) = send(&app, "DELETE", &path, Some(&admin_token), None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(&app, "DELETE", &path, Some(&admin_token), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

// ---------------------------------------------------------------------------
// oidc
// ---------------------------------------------------------------------------

#[sqlx::test]
async fn oidc_routes_absent_when_not_configured(pool: PgPool) {
    let app = app(&pool, true);
    let (status, _) = send(&app, "GET", "/api/oidc/login", None, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = send(&app, "GET", "/api/oidc/callback?code=x&state=y", None, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

// ---------------------------------------------------------------------------
// pure helpers (no DB)
// ---------------------------------------------------------------------------

#[test]
fn oidc_username_mapping() {
    assert_eq!(map_oidc_username("bob").unwrap(), "bob");
    assert_eq!(map_oidc_username("Alice.Smith").unwrap(), "alicesmith");
    assert_eq!(map_oidc_username("User Name+42").unwrap(), "username42");
    // A bare `sub` UUID maps cleanly (hyphens are legal username chars).
    let sub = "550e8400-e29b-41d4-a716-446655440000";
    assert_eq!(map_oidc_username(sub).unwrap(), &sub[..32]);
    // Nothing usable left -> error, never a guessed identity.
    assert!(map_oidc_username("!!").is_err());
    assert!(map_oidc_username("").is_err());
    assert!(map_oidc_username("郝郝").is_err());
}

#[test]
fn username_validation_rules() {
    assert_eq!(validate_username("Alice").unwrap(), "alice");
    assert_eq!(validate_username(" bob_1-2 ").unwrap(), "bob_1-2");
    for bad in ["ab", "a b", "a.b.c", "toolong-toolong-toolong-toolong-x"] {
        assert!(validate_username(bad).is_err(), "{bad:?}");
    }
}

#[test]
fn display_name_sanitizer_rules() {
    assert_eq!(sanitize_display_name("plain name"), "plain name");
    assert_eq!(sanitize_display_name("<i>x&y</i>"), "ixy/i");
    assert_eq!(
        sanitize_display_name("a\u{202E}b\u{200B}c\u{0007}d"),
        "abcd"
    );
    assert_eq!(sanitize_display_name("  padded  "), "padded");
    assert_eq!(sanitize_display_name(&"z".repeat(100)).len(), 64);
    assert_eq!(sanitize_display_name("\u{FEFF}\u{2066}"), "");
}

// ---------------------------------------------------------------------------
// KeyPackage pool: replace-on-rekey semantics
// ---------------------------------------------------------------------------

/// Upload a batch of opaque KeyPackages for `token`, optionally replacing the
/// existing pool (the client's identity changed) and/or the last-resort slot.
async fn upload_kps(
    app: &Router,
    token: &str,
    count: usize,
    tag: &str,
    replace: bool,
    last_resort: Option<&str>,
) -> (StatusCode, Value) {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut body = json!({
        "key_packages": (0..count)
            .map(|i| b64.encode(format!("kp-{tag}-{i}")))
            .collect::<Vec<_>>(),
        "replace": replace,
    });
    if let Some(lr) = last_resort {
        body["last_resort"] = json!(b64.encode(lr));
    }
    send(app, "POST", "/api/mls/keys", Some(token), Some(body)).await
}

#[sqlx::test]
async fn keypackage_replace_drops_stale_pool(pool: PgPool) {
    let app = app(&pool, true);
    let (_, alice) = register(&app, "alice", "password-1", None).await;
    let alice = token_of(&alice);

    // Old identity: 3 regular packages + a last resort.
    let (status, _) = upload_kps(&app, &alice, 3, "old", false, Some("lr-old")).await;
    assert_eq!(status, StatusCode::OK);
    let (_, count) = send(&app, "GET", "/api/mls/keys/count", Some(&alice), None).await;
    assert_eq!(count["count"], 3);
    assert_eq!(count["has_last_resort"], true);

    // Re-key with replace: the stale pool AND the stale last resort go away.
    let (status, body) = upload_kps(&app, &alice, 2, "new", true, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["has_last_resort"], false);
    let (_, count) = send(&app, "GET", "/api/mls/keys/count", Some(&alice), None).await;
    assert_eq!(count["count"], 2);
    assert_eq!(count["has_last_resort"], false);

    // A claimer only ever sees fresh-identity packages.
    let (_, bob) = register(&app, "bob", "password-1", None).await;
    let bob = token_of(&bob);
    let (_, _) = send(
        &app,
        "POST",
        "/api/shares/request",
        Some(&bob),
        Some(json!({ "to_user_id": format!("alice@{DOMAIN}") })),
    )
    .await;
    // Accept so bob is allowed to claim (consent gate).
    let (_, reqs) = send(&app, "GET", "/api/shares/requests", Some(&alice), None).await;
    let req_id = reqs[0]["id"].as_str().unwrap().to_string();
    let (status, _) = send(
        &app,
        "POST",
        &format!("/api/shares/requests/{req_id}/accept"),
        Some(&alice),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD;
    let (status, claimed) = send(
        &app,
        "POST",
        &format!("/api/mls/keys/alice@{DOMAIN}/claim"),
        Some(&bob),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let kp = b64
        .decode(claimed["key_package"].as_str().unwrap())
        .unwrap();
    assert!(String::from_utf8(kp).unwrap().starts_with("kp-new-"));

    // Replace does not touch consumed rows (history stays consistent): after
    // the claim, 1 remains; replacing with 1 fresh yields exactly 1.
    let (status, _) = upload_kps(&app, &alice, 1, "newer", true, None).await;
    assert_eq!(status, StatusCode::OK);
    let (_, count) = send(&app, "GET", "/api/mls/keys/count", Some(&alice), None).await;
    assert_eq!(count["count"], 1);
}

// ---------------------------------------------------------------------------
// Wave B: profile, privacy (who_can_add_me), avatar
// ---------------------------------------------------------------------------

#[sqlx::test]
async fn profile_update_sanitizes_and_persists(pool: PgPool) {
    let app = app(&pool, true);
    let (_, alice) = register(&app, "alice", "password-1", None).await;
    let alice = token_of(&alice);

    let (status, v) = send(
        &app,
        "PUT",
        "/api/account/profile",
        Some(&alice),
        Some(json!({ "display_name": "  <b>Alice</b> P. " })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["display_name"], "bAlice/b P.");

    let (_, me) = send(&app, "GET", "/api/me", Some(&alice), None).await;
    assert_eq!(me["display_name"], "bAlice/b P.");

    // Nothing-left-after-sanitizing is a 400, not an empty name.
    let (status, _) = send(
        &app,
        "PUT",
        "/api/account/profile",
        Some(&alice),
        Some(json!({ "display_name": "\u{202E}\u{200B}" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[sqlx::test]
async fn who_can_add_me_nobody_silently_drops_requests(pool: PgPool) {
    let app = app(&pool, true);
    let (_, alice) = register(&app, "alice", "password-1", None).await;
    let alice = token_of(&alice);
    let (_, bob) = register(&app, "bob", "password-1", None).await;
    let bob = token_of(&bob);

    let (status, v) = send(
        &app,
        "PUT",
        "/api/account/privacy",
        Some(&alice),
        Some(json!({ "who_can_add_me": "nobody" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["who_can_add_me"], "nobody");

    // Bob's ask returns the same generic ok as any other outcome...
    let (status, _) = send(
        &app,
        "POST",
        "/api/shares/request",
        Some(&bob),
        Some(json!({ "to_user_id": format!("alice@{DOMAIN}") })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // ...but nothing lands in Alice's inbox.
    let (_, reqs) = send(&app, "GET", "/api/shares/requests", Some(&alice), None).await;
    assert_eq!(reqs.as_array().map(Vec::len), Some(0));

    // Alice can still initiate outward: 'nobody' gates inbound only.
    let (status, _) = send(
        &app,
        "POST",
        "/api/shares/request",
        Some(&alice),
        Some(json!({ "to_user_id": format!("bob@{DOMAIN}") })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, reqs) = send(&app, "GET", "/api/shares/requests", Some(&bob), None).await;
    assert_eq!(reqs.as_array().map(Vec::len), Some(1));

    // Bad value is an honest 400.
    let (status, _) = send(
        &app,
        "PUT",
        "/api/account/privacy",
        Some(&alice),
        Some(json!({ "who_can_add_me": "friends" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[sqlx::test]
async fn avatar_roundtrip_is_relationship_gated(pool: PgPool) {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD;
    let app = app(&pool, true);
    let (_, alice) = register(&app, "alice", "password-1", None).await;
    let alice = token_of(&alice);
    let (_, bob) = register(&app, "bob", "password-1", None).await;
    let bob = token_of(&bob);
    let (_, mallory) = register(&app, "mallory", "password-1", None).await;
    let mallory = token_of(&mallory);

    // A tiny valid PNG header + payload (magic bytes are what the server sniffs).
    let png: Vec<u8> = [
        &[0x89u8, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A][..],
        &[0u8; 32][..],
    ]
    .concat();
    let (status, _) = send(
        &app,
        "POST",
        "/api/account/avatar",
        Some(&alice),
        Some(json!({ "data": b64.encode(&png), "mime": "image/png" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, me) = send(&app, "GET", "/api/me", Some(&alice), None).await;
    assert_eq!(me["has_avatar"], true);

    // Mime/bytes mismatch and oversize are rejected.
    let (status, _) = send(
        &app,
        "POST",
        "/api/account/avatar",
        Some(&alice),
        Some(json!({ "data": b64.encode(&png), "mime": "image/jpeg" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let big = [&png[..], &vec![0u8; 128 * 1024][..]].concat();
    let (status, _) = send(
        &app,
        "POST",
        "/api/account/avatar",
        Some(&alice),
        Some(json!({ "data": b64.encode(&big), "mime": "image/png" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // A stranger sees 404; a pending requester may look; self always may.
    let (status, _) = send(
        &app,
        "GET",
        &format!("/api/users/alice@{DOMAIN}/avatar"),
        Some(&mallory),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = send(
        &app,
        "GET",
        &format!("/api/users/alice@{DOMAIN}/avatar"),
        Some(&alice),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, _) = send(
        &app,
        "POST",
        "/api/shares/request",
        Some(&bob),
        Some(json!({ "to_user_id": format!("alice@{DOMAIN}") })),
    )
    .await;
    let (status, _) = send(
        &app,
        "GET",
        &format!("/api/users/alice@{DOMAIN}/avatar"),
        Some(&bob),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Delete returns to the monogram (404 even for self).
    let (status, _) = send(&app, "DELETE", "/api/account/avatar", Some(&alice), None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(
        &app,
        "GET",
        &format!("/api/users/alice@{DOMAIN}/avatar"),
        Some(&alice),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

// ---------------------------------------------------------------------------
// Wave C: the proxied tile tier
// ---------------------------------------------------------------------------

/// Router with a tile upstream configured (the convenient tier).
fn app_with_tile_upstream(pool: &PgPool, upstream_template: &str) -> Router {
    let mut state = test_state(pool.clone(), true);
    let mut config = (*state.config).clone();
    config.tile_upstream = Some(upstream_template.to_string());
    state.config = Arc::new(config);
    super::router(state)
}

/// A minimal in-process tile upstream: serves a PNG-magic body for any
/// /t/{z}/{x}/{y} path, plus a /html path that lies about being a tile.
async fn spawn_fake_upstream() -> String {
    use axum::routing::get;
    let router = Router::new()
        .route(
            "/t/{z}/{x}/{y}",
            get(|| async {
                (
                    [(axum::http::header::CONTENT_TYPE, "image/png")],
                    vec![0x89u8, b'P', b'N', b'G', 1, 2, 3, 4],
                )
            }),
        )
        .route(
            "/html/{z}/{x}/{y}",
            get(|| async {
                (
                    [(axum::http::header::CONTENT_TYPE, "text/html")],
                    "<html>not a tile</html>".to_string(),
                )
            }),
        )
        .route(
            "/huge/{z}/{x}/{y}",
            get(|| async {
                (
                    [(axum::http::header::CONTENT_TYPE, "image/png")],
                    vec![0u8; 4 * 1024 * 1024],
                )
            }),
        )
        .route(
            "/nocontenttype/{z}/{x}/{y}",
            get(|| async { vec![1u8, 2, 3, 4] }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    format!("http://{addr}")
}

#[sqlx::test]
async fn tile_proxy_streams_validates_and_gates(pool: PgPool) {
    let upstream = spawn_fake_upstream().await;

    // No upstream configured: the route answers 404, honestly absent.
    let bare = app(&pool, true);
    let (_, alice) = register(&bare, "alice", "password-1", None).await;
    let alice = token_of(&alice);
    let (status, _) = send(&bare, "GET", "/api/tiles/3/1/2", Some(&alice), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let app = app_with_tile_upstream(&pool, &format!("{upstream}/t/{{z}}/{{x}}/{{y}}"));

    // Auth required: this is a member service, not an open proxy.
    let (status, _) = send(&app, "GET", "/api/tiles/3/1/2", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Happy path: bytes stream through with the image content type.
    let request = Request::builder()
        .method("GET")
        .uri("/api/tiles/3/1/2")
        .header("authorization", format!("Bearer {alice}"))
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok()),
        Some("image/png")
    );
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&bytes[..4], &[0x89, b'P', b'N', b'G']);

    // Tile math: x/y beyond 2^z is an honest 400, never an upstream fetch.
    let (status, _) = send(&app, "GET", "/api/tiles/3/9/2", Some(&alice), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // A non-image upstream response never leaves the proxy.
    let html = app_with_tile_upstream(&pool, &format!("{upstream}/html/{{z}}/{{x}}/{{y}}"));
    let (status, _) = send(&html, "GET", "/api/tiles/3/1/2", Some(&alice), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // A declared-oversize tile is rejected (not buffered).
    let huge = app_with_tile_upstream(&pool, &format!("{upstream}/huge/{{z}}/{{x}}/{{y}}"));
    let (status, _) = send(&huge, "GET", "/api/tiles/3/1/2", Some(&alice), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // An upstream that omits Content-Type is not optimistically served.
    let untyped = app_with_tile_upstream(
        &pool,
        &format!("{upstream}/nocontenttype/{{z}}/{{x}}/{{y}}"),
    );
    let (status, _) = send(&untyped, "GET", "/api/tiles/3/1/2", Some(&alice), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
