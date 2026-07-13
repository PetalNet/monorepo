//! Federation unit + DB tests. Pure functions (SSRF classification, replay
//! window, hostname denylist) are tested directly; the DB paths (TOFU pin,
//! federated shadow users, share.accept anti-forgery) run under `#[sqlx::test]`
//! against a fresh migrated Postgres, matching the `api::tests` harness.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::Arc;

use serde_json::{json, Value};
use sqlx::PgPool;

use super::*;
use crate::api::tests::{test_state, DOMAIN};
use crate::error::AppError;

fn uid(name: &str) -> String {
    format!("{name}@{DOMAIN}")
}

async fn seed_local_user(pool: &PgPool, id: &str) {
    sqlx::query("INSERT INTO users (id, display_name) VALUES ($1, $1)")
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
}

// ---------------------------------------------------------------------------
// SSRF classification (pure)
// ---------------------------------------------------------------------------

#[test]
fn ip_disallowed_rejects_non_public_v4() {
    let deny = [
        "127.0.0.1",       // loopback
        "10.0.0.5",        // private
        "192.168.1.1",     // private
        "172.16.0.1",      // private
        "169.254.0.1",     // link-local
        "0.0.0.0",         // unspecified
        "224.0.0.1",       // multicast
        "255.255.255.255", // broadcast
        "100.64.0.1",      // CGNAT shared
    ];
    for s in deny {
        let ip: IpAddr = s.parse().unwrap();
        assert!(ip_disallowed(ip), "{s} must be disallowed");
    }
    // A genuine public address is allowed.
    assert!(!ip_disallowed(IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34))));
    assert!(!ip_disallowed(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))));
}

#[test]
fn ip_disallowed_rejects_non_public_v6() {
    let deny = ["::1", "::", "fc00::1", "fd12::1", "fe80::1", "ff02::1"];
    for s in deny {
        let ip: IpAddr = s.parse().unwrap();
        assert!(ip_disallowed(ip), "{s} must be disallowed");
    }
    // IPv4-mapped loopback must be caught via the embedded v4 address.
    assert!(ip_disallowed(IpAddr::V6(
        "::ffff:127.0.0.1".parse::<Ipv6Addr>().unwrap()
    )));
    // A public v6 is allowed.
    assert!(!ip_disallowed(IpAddr::V6(
        "2606:4700:4700::1111".parse().unwrap()
    )));
}

#[test]
fn hostname_denylist_catches_the_usual_suspects() {
    for h in [
        "localhost",
        "LOCALHOST",
        "foo.local",
        "svc.internal",
        "metadata.google.internal",
        "127.0.0.1", // bare IP literal
        "10.0.0.1",
        "[::1]", // bracketed v6 literal
        "app.localhost",
        "",
    ] {
        assert!(hostname_denied(h), "{h:?} must be denied");
    }
    // A normal public hostname is not on the denylist.
    assert!(!hostname_denied("point.example.org"));
    assert!(!hostname_denied("a.example"));
}

#[tokio::test]
async fn ssrf_check_bypassed_when_allow_private() {
    // allow_private short-circuits the whole guard (localhost integration test).
    assert!(ssrf_check("127.0.0.1", true).await.is_ok());
    assert!(ssrf_check("127.0.0.1:8331", true).await.is_ok());
    assert!(ssrf_check("localhost", true).await.is_ok());
}

#[tokio::test]
async fn ssrf_check_rejects_literal_loopback_when_not_allowed() {
    let err = ssrf_check("127.0.0.1", false).await.unwrap_err();
    assert!(matches!(err, AppError::Forbidden));
    // With a port, too.
    let err = ssrf_check("10.0.0.1:443", false).await.unwrap_err();
    assert!(matches!(err, AppError::Forbidden));
    let err = ssrf_check("localhost", false).await.unwrap_err();
    assert!(matches!(err, AppError::Forbidden));
}

// ---------------------------------------------------------------------------
// replay window (pure)
// ---------------------------------------------------------------------------

#[test]
fn replay_window_is_plus_minus_300s() {
    let now = 1_000_000i64;
    assert!(replay_ok(now, now));
    assert!(replay_ok(now - 300, now)); // exactly at the edge
    assert!(replay_ok(now + 300, now));
    assert!(!replay_ok(now - 301, now)); // stale
    assert!(!replay_ok(now + 301, now)); // future
    assert!(!replay_ok(now - 100_000, now));
}

// ---------------------------------------------------------------------------
// TOFU pin (DB)
// ---------------------------------------------------------------------------

#[sqlx::test]
async fn tofu_pin_stores_on_first_contact_and_rejects_a_changed_key(pool: PgPool) {
    let local = uid("alice");
    let remote = "bob@remote.example";
    seed_local_user(&pool, &local).await;

    // First contact pins the key.
    tofu_pin(&pool, &local, remote, "hash-A").await.unwrap();
    let (pinned,): (String,) = sqlx::query_as(
        "SELECT key_hash FROM federation_pins WHERE local_user_id = $1 AND remote_user_id = $2",
    )
    .bind(&local)
    .bind(remote)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(pinned, "hash-A");

    // Same key again: idempotent no-op.
    tofu_pin(&pool, &local, remote, "hash-A").await.unwrap();

    // A CHANGED key on a later contact is a fail-closed reject...
    let err = tofu_pin(&pool, &local, remote, "hash-B").await.unwrap_err();
    assert!(matches!(err, AppError::Forbidden));

    // ...and the stored pin is untouched (still the original key).
    let (still,): (String,) = sqlx::query_as(
        "SELECT key_hash FROM federation_pins WHERE local_user_id = $1 AND remote_user_id = $2",
    )
    .bind(&local)
    .bind(remote)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(still, "hash-A");
}

// ---------------------------------------------------------------------------
// federated shadow user (DB)
// ---------------------------------------------------------------------------

#[sqlx::test]
async fn ensure_federated_user_creates_shadow_and_entity_idempotently(pool: PgPool) {
    let remote = "carol@remote.example";
    ensure_federated_user(&pool, remote).await.unwrap();

    let (is_federated, has_password): (bool, bool) =
        sqlx::query_as("SELECT is_federated, password_hash IS NOT NULL FROM users WHERE id = $1")
            .bind(remote)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(is_federated, "shadow user must be marked federated");
    assert!(!has_password, "shadow user must have NULL password_hash");

    let (entities,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM entities WHERE owner_id = $1 AND kind = 'person'")
            .bind(remote)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(entities, 1);

    // Idempotent: a second call neither errors nor duplicates the entity.
    ensure_federated_user(&pool, remote).await.unwrap();
    let (entities,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM entities WHERE owner_id = $1 AND kind = 'person'")
            .bind(remote)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(entities, 1);
}

// ---------------------------------------------------------------------------
// share.accept anti-forgery (DB)
// ---------------------------------------------------------------------------

#[sqlx::test]
async fn share_accept_without_pending_outbound_is_rejected(pool: PgPool) {
    let state = test_state(pool.clone(), true);
    let local = uid("alice");
    let remote = "mallory@remote.example";
    seed_local_user(&pool, &local).await;

    // No local -> remote pending request exists: a claimed accept is forged.
    let err = handle_share_accept(&state, remote, &local, &json!({}))
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::Forbidden));

    let (shares,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM user_shares")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(shares, 0, "no share may be created from a forged accept");
}

#[sqlx::test]
async fn share_accept_with_matching_pending_outbound_creates_the_share(pool: PgPool) {
    let state = test_state(pool.clone(), true);
    let local = uid("alice");
    let remote = "bob@remote.example";
    seed_local_user(&pool, &local).await;
    // The remote must exist (FK) for the outbound request row.
    ensure_federated_user(&pool, remote).await.unwrap();

    // Local user's outbound pending request to the remote.
    sqlx::query("INSERT INTO share_requests (from_user_id, to_user_id) VALUES ($1, $2)")
        .bind(&local)
        .bind(remote)
        .execute(&pool)
        .await
        .unwrap();

    let out = handle_share_accept(&state, remote, &local, &json!({}))
        .await
        .unwrap();
    assert_eq!(out["ok"], true);

    // The permanent share now exists in canonical order.
    let (lo, hi) = if remote < local.as_str() {
        (remote, local.as_str())
    } else {
        (local.as_str(), remote)
    };
    let (shares,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM user_shares WHERE user_a = $1 AND user_b = $2")
            .bind(lo)
            .bind(hi)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(shares, 1);

    // The request is now accepted.
    let (status,): (String,) = sqlx::query_as(
        "SELECT status FROM share_requests WHERE from_user_id = $1 AND to_user_id = $2",
    )
    .bind(&local)
    .bind(remote)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(status, "accepted");
}

#[sqlx::test]
async fn federated_share_remove_tears_down_local_half(pool: PgPool) {
    let state = test_state(pool.clone(), true);
    let local = uid("alice");
    let remote = "bob@remote.example";
    seed_local_user(&pool, &local).await;
    ensure_federated_user(&pool, remote).await.unwrap();
    let (lo, hi) = if remote < local.as_str() {
        (remote, local.as_str())
    } else {
        (local.as_str(), remote)
    };
    sqlx::query("INSERT INTO user_shares (user_a, user_b) VALUES ($1, $2)")
        .bind(lo)
        .bind(hi)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO share_requests (from_user_id, to_user_id, status) VALUES ($1, $2, 'accepted')",
    )
    .bind(&local)
    .bind(remote)
    .execute(&pool)
    .await
    .unwrap();

    let out = handle_share_remove(&state, remote, &local).await.unwrap();
    assert_eq!(out["ok"], true);
    let (shares,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM user_shares")
        .fetch_one(&pool)
        .await
        .unwrap();
    let (requests,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM share_requests")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!((shares, requests), (0, 0));
}

#[sqlx::test]
async fn federated_profile_update_refreshes_shadow_and_notifies_local_peer(pool: PgPool) {
    let state = test_state(pool.clone(), true);
    let local = uid("alice");
    let remote = "bob@remote.example";
    seed_local_user(&pool, &local).await;
    ensure_federated_user(&pool, remote).await.unwrap();
    let (lo, hi) = if remote < local.as_str() {
        (remote, local.as_str())
    } else {
        (local.as_str(), remote)
    };
    sqlx::query("INSERT INTO user_shares (user_a, user_b) VALUES ($1, $2)")
        .bind(lo)
        .bind(hi)
        .execute(&pool)
        .await
        .unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::channel(2);
    state
        .hub
        .add_connection(&local, tx, Arc::new(tokio::sync::Notify::new()));

    let png = [&[0x89u8, b'P', b'N', b'G'][..], &[0u8; 8][..]].concat();
    let out = handle_profile_updated(
        &state,
        remote,
        &local,
        &json!({
            "profile_version": 42,
            "display_name": "Bob Remote",
            "avatar_changed": true,
            "avatar": BASE64.encode(&png),
            "avatar_mime": "image/png",
        }),
    )
    .await
    .unwrap();
    assert_eq!(out["ok"], true);

    let (name, avatar): (String, Option<Vec<u8>>) =
        sqlx::query_as("SELECT display_name, avatar FROM users WHERE id = $1")
            .bind(remote)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(name, "Bob Remote");
    assert_eq!(avatar, Some(png));
    let event: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
    assert_eq!(event["type"], "profile.updated");
    assert_eq!(event["user_id"], remote);
    assert_eq!(event["profile_version"], 42);
}
