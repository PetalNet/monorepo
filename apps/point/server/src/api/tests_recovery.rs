//! Zero-knowledge recovery-backup endpoint tests: per-user isolation, opaque
//! round-trip, replace-on-reupload, and — the load-bearing property — the server
//! stores exactly the ciphertext it was handed and can produce nothing else.
//! Same harness as `api::tests`: real router, real per-test Postgres.

use axum::http::StatusCode;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::json;
use sqlx::PgPool;

use super::tests::{app, register, send, token_of, DOMAIN};

async fn user(pool: &PgPool, name: &str) -> String {
    let (status, v) = register(&app(pool, true), name, "password1", None).await;
    assert_eq!(status, StatusCode::OK, "register {name}: {v}");
    token_of(&v)
}

#[sqlx::test]
async fn backup_roundtrips_opaque_bytes(pool: PgPool) {
    let app = app(&pool, true);
    let alice = user(&pool, "alice").await;

    // A client-produced recovery blob (server treats it as opaque bytes).
    let blob = point_core::recovery::encrypt(b"alice-mls-state", "ALICE-RECOVERY-CODE").unwrap();
    let b64 = BASE64.encode(&blob);

    // No backup yet -> 404.
    let (status, _) = send(&app, "GET", "/api/recovery/backup", Some(&alice), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Store it.
    let (status, v) = send(
        &app,
        "PUT",
        "/api/recovery/backup",
        Some(&alice),
        Some(json!({ "blob": b64 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "put: {v}");

    // Fetch it back — byte-identical.
    let (status, v) = send(&app, "GET", "/api/recovery/backup", Some(&alice), None).await;
    assert_eq!(status, StatusCode::OK);
    let got = BASE64.decode(v["blob"].as_str().unwrap()).unwrap();
    assert_eq!(
        got, blob,
        "server returned a different blob than it was given"
    );

    // And it actually decrypts on the client with the right code.
    let state = point_core::recovery::decrypt(&got, "ALICE-RECOVERY-CODE").unwrap();
    assert_eq!(state, b"alice-mls-state");
}

#[sqlx::test]
async fn reupload_replaces_the_backup(pool: PgPool) {
    let app = app(&pool, true);
    let alice = user(&pool, "alice").await;

    let first = BASE64.encode(point_core::recovery::encrypt(b"v1", "FIRST-CODE-1111").unwrap());
    let second = BASE64.encode(point_core::recovery::encrypt(b"v2", "SECOND-CODE-2222").unwrap());

    for b in [&first, &second] {
        let (status, _) = send(
            &app,
            "PUT",
            "/api/recovery/backup",
            Some(&alice),
            Some(json!({ "blob": b })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }

    // Only the latest survives (single row per user), and it decrypts with the
    // second code, not the first.
    let (_, v) = send(&app, "GET", "/api/recovery/backup", Some(&alice), None).await;
    let got = BASE64.decode(v["blob"].as_str().unwrap()).unwrap();
    assert_eq!(
        point_core::recovery::decrypt(&got, "SECOND-CODE-2222").unwrap(),
        b"v2"
    );
    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM mls_backups WHERE user_id = $1")
        .bind(format!("alice@{DOMAIN}"))
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 1);
}

#[sqlx::test]
async fn one_user_cannot_read_another_users_backup(pool: PgPool) {
    let app = app(&pool, true);
    let alice = user(&pool, "alice").await;
    let bob = user(&pool, "bob").await;

    let blob = BASE64.encode(point_core::recovery::encrypt(b"alice-only", "SECRET-CODE").unwrap());
    let (status, _) = send(
        &app,
        "PUT",
        "/api/recovery/backup",
        Some(&alice),
        Some(json!({ "blob": blob })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Bob has no backup of his own — the endpoint is scoped to the caller, so he
    // gets 404, never Alice's blob.
    let (status, _) = send(&app, "GET", "/api/recovery/backup", Some(&bob), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[sqlx::test]
async fn unauthenticated_and_malformed_are_rejected(pool: PgPool) {
    let app = app(&pool, true);
    let alice = user(&pool, "alice").await;

    // No token.
    let (status, _) = send(&app, "GET", "/api/recovery/backup", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Not base64.
    let (status, _) = send(
        &app,
        "PUT",
        "/api/recovery/backup",
        Some(&alice),
        Some(json!({ "blob": "!!!not base64!!!" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Empty.
    let (status, _) = send(
        &app,
        "PUT",
        "/api/recovery/backup",
        Some(&alice),
        Some(json!({ "blob": "" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[sqlx::test]
async fn delete_removes_the_backup(pool: PgPool) {
    let app = app(&pool, true);
    let alice = user(&pool, "alice").await;

    let blob = BASE64.encode(point_core::recovery::encrypt(b"state", "CODE-CODE").unwrap());
    send(
        &app,
        "PUT",
        "/api/recovery/backup",
        Some(&alice),
        Some(json!({ "blob": blob })),
    )
    .await;

    let (status, _) = send(&app, "DELETE", "/api/recovery/backup", Some(&alice), None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(&app, "GET", "/api/recovery/backup", Some(&alice), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
