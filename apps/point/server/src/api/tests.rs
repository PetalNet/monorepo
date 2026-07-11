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

const DOMAIN: &str = "test.example";

fn test_state(pool: PgPool, open_registration: bool) -> AppState {
    AppState {
        pool,
        config: Arc::new(Config {
            database_url: String::new(),
            listen: "127.0.0.1:0".into(),
            jwt_secret: "unit-test-secret-0123456789abcdef".into(),
            domain: DOMAIN.into(),
            open_registration,
            glitchtip_dsn: None,
            oidc: None,
        }),
        hub: Arc::new(Hub::default()),
    }
}

/// Fresh router (fresh rate limiter) over shared DB state.
fn app(pool: &PgPool, open_registration: bool) -> Router {
    super::router(test_state(pool.clone(), open_registration))
}

async fn send(
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

async fn register(
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

async fn login(app: &Router, username: &str, password: &str) -> (StatusCode, Value) {
    send(
        app,
        "POST",
        "/api/login",
        None,
        Some(json!({ "username": username, "password": password })),
    )
    .await
}

fn token_of(v: &Value) -> String {
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

#[sqlx::test]
async fn login_rate_limit_fires_on_11th_attempt(pool: PgPool) {
    let app = app(&pool, true);
    let (status, _) = register(&app, "alice", "password1", None).await;
    assert_eq!(status, StatusCode::OK);

    for i in 1..=10 {
        let (status, _) = login(&app, "alice", "wrong-password").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "attempt {i}");
    }
    let (status, _) = login(&app, "alice", "wrong-password").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);

    // The right password is also throttled: the window is per username.
    let (status, _) = login(&app, "alice", "password1").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
}

#[sqlx::test]
async fn register_global_rate_limit_fires_on_6th_attempt(pool: PgPool) {
    let app = app(&pool, true);
    for i in 1..=5 {
        let (status, _) = register(&app, &format!("user{i}"), "password1", None).await;
        assert_eq!(status, StatusCode::OK, "register {i}");
    }
    let (status, _) = register(&app, "user6", "password1", None).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
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
