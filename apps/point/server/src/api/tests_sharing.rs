//! Wave-B integration tests: shares, groups, ghost, history — plus direct
//! tests of the `authz` gate against seeded data. Same harness as
//! `api::tests`: real router, real per-test Postgres, tower oneshot.

use axum::http::StatusCode;
use axum::Router;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use crate::authz;

use super::tests::{app, register, send, token_of, DOMAIN};

fn uid(name: &str) -> String {
    format!("{name}@{DOMAIN}")
}

/// Register via the API (fresh router per call so the register rate limit
/// never interferes) and return the bearer token.
async fn user(pool: &PgPool, name: &str) -> String {
    let (status, v) = register(&app(pool, true), name, "password1", None).await;
    assert_eq!(status, StatusCode::OK, "register {name}: {v}");
    token_of(&v)
}

/// Bare users row for authz-gate tests (no API surface involved).
async fn seed_user(pool: &PgPool, id: &str) {
    sqlx::query("INSERT INTO users (id, display_name) VALUES ($1, $1)")
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
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

async fn count(pool: &PgPool, sql: &str) -> i64 {
    let (n,): (i64,) = sqlx::query_as(sql).fetch_one(pool).await.unwrap();
    n
}

// ---------------------------------------------------------------------------
// share requests + permanent shares
// ---------------------------------------------------------------------------

#[sqlx::test]
async fn share_request_accept_lifecycle(pool: PgPool) {
    let app = app(&pool, true);
    let alice = user(&pool, "alice").await;
    let bob = user(&pool, "bob").await;
    let carol = user(&pool, "carol").await;

    // Create a request; nonexistent target gets the identical 200 and records
    // nothing (enumeration-safe); duplicates in both directions are idempotent.
    let (status, v) = send(
        &app,
        "POST",
        "/api/shares/request",
        Some(&alice),
        Some(json!({ "to_user_id": uid("bob") })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    let (status, v2) = send(
        &app,
        "POST",
        "/api/shares/request",
        Some(&alice),
        Some(json!({ "to_user_id": uid("nobody") })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v, v2, "success and pretend-success must be identical");
    let (status, _) = send(
        &app,
        "POST",
        "/api/shares/request",
        Some(&alice),
        Some(json!({ "to_user_id": uid("bob") })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(
        &app,
        "POST",
        "/api/shares/request",
        Some(&bob),
        Some(json!({ "to_user_id": uid("alice") })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM share_requests").await, 1);

    // Self-request is an honest 400 (no enumeration value in yourself).
    let (status, _) = send(
        &app,
        "POST",
        "/api/shares/request",
        Some(&alice),
        Some(json!({ "to_user_id": uid("alice") })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Incoming for bob, outgoing for alice.
    let (status, incoming) = send(&app, "GET", "/api/shares/requests", Some(&bob), None).await;
    assert_eq!(status, StatusCode::OK);
    let incoming = incoming.as_array().unwrap();
    assert_eq!(incoming.len(), 1);
    assert_eq!(incoming[0]["from_user_id"], uid("alice"));
    assert_eq!(incoming[0]["from_display_name"], "alice");
    let request_id = incoming[0]["id"].as_str().unwrap().to_string();

    let (status, outgoing) = send(
        &app,
        "GET",
        "/api/shares/requests/outgoing",
        Some(&alice),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(outgoing[0]["to_user_id"], uid("bob"));

    // Only the addressee may accept; everyone else sees the same 404.
    let accept_path = format!("/api/shares/requests/{request_id}/accept");
    let (status, _) = send(&app, "POST", &accept_path, Some(&carol), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = send(&app, "POST", &accept_path, Some(&alice), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, v) = send(&app, "POST", &accept_path, Some(&bob), None).await;
    assert_eq!(status, StatusCode::OK, "{v}");

    // Both sides now list the share.
    let (status, shares) = send(&app, "GET", "/api/shares", Some(&alice), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(shares[0]["user_id"], uid("bob"));
    assert_eq!(shares[0]["display_name"], "bob");
    assert!(shares[0]["since"].is_string());
    let (_, shares) = send(&app, "GET", "/api/shares", Some(&bob), None).await;
    assert_eq!(shares[0]["user_id"], uid("alice"));

    // Request consumed: no longer pending, accepting again 404s, and a fresh
    // request against an existing share is a no-op 200.
    let (_, incoming) = send(&app, "GET", "/api/shares/requests", Some(&bob), None).await;
    assert_eq!(incoming.as_array().unwrap().len(), 0);
    let (status, _) = send(&app, "POST", &accept_path, Some(&bob), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = send(
        &app,
        "POST",
        "/api/shares/request",
        Some(&alice),
        Some(json!({ "to_user_id": uid("bob") })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM share_requests").await, 1);
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM user_shares").await, 1);
}

#[sqlx::test]
async fn share_reject_and_delete(pool: PgPool) {
    let app = app(&pool, true);
    let alice = user(&pool, "alice").await;
    let bob = user(&pool, "bob").await;

    let (_, _) = send(
        &app,
        "POST",
        "/api/shares/request",
        Some(&alice),
        Some(json!({ "to_user_id": uid("bob") })),
    )
    .await;
    let (_, incoming) = send(&app, "GET", "/api/shares/requests", Some(&bob), None).await;
    let request_id = incoming[0]["id"].as_str().unwrap().to_string();

    // The requester can't reject their own outgoing request.
    let reject_path = format!("/api/shares/requests/{request_id}/reject");
    let (status, _) = send(&app, "POST", &reject_path, Some(&alice), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = send(&app, "POST", &reject_path, Some(&bob), None).await;
    assert_eq!(status, StatusCode::OK);

    // No share came out of it; the pair has no pending request left.
    let (_, shares) = send(&app, "GET", "/api/shares", Some(&alice), None).await;
    assert_eq!(shares.as_array().unwrap().len(), 0);
    let (_, incoming) = send(&app, "GET", "/api/shares/requests", Some(&bob), None).await;
    assert_eq!(incoming.as_array().unwrap().len(), 0);

    // Deleting a share works from either party; a second delete 404s.
    seed_share(&pool, &uid("alice"), &uid("bob")).await;
    let path = format!("/api/shares/{}", uid("alice"));
    let (status, _) = send(&app, "DELETE", &path, Some(&bob), None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(&app, "DELETE", &path, Some(&bob), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM user_shares").await, 0);
}

#[sqlx::test]
async fn share_request_rate_limit(pool: PgPool) {
    let app = app(&pool, true);
    let alice = user(&pool, "alice").await;

    // 30/min per user; the 31st attempt trips it (pretend-success attempts
    // against nonexistent users count too — probing is what the limit is for).
    for i in 1..=30 {
        let (status, _) = send(
            &app,
            "POST",
            "/api/shares/request",
            Some(&alice),
            Some(json!({ "to_user_id": uid("nobody") })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "attempt {i}");
    }
    let (status, _) = send(
        &app,
        "POST",
        "/api/shares/request",
        Some(&alice),
        Some(json!({ "to_user_id": uid("nobody") })),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
}

/// End-to-end proof of the `COLLATE "C"` path (D-016): usernames whose byte
/// order differs from en_US collation (which treats '-' as ignorable) must
/// still request → accept → appear in GET /api/shares. "ab-c@..." sorts BEFORE
/// "abb@..." bytewise ('-' 0x2D < 'b' 0x62) but AFTER under en_US — if the
/// server's Rust ordering and the DB CHECK disagreed, the accept INSERT would
/// violate the CHECK and 500.
#[sqlx::test]
async fn share_collation_hyphen_underscore_end_to_end(pool: PgPool) {
    let app = app(&pool, true);
    let abc = user(&pool, "ab-c").await;
    let abb = user(&pool, "abb").await;

    let (status, _) = send(
        &app,
        "POST",
        "/api/shares/request",
        Some(&abc),
        Some(json!({ "to_user_id": uid("abb") })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (_, incoming) = send(&app, "GET", "/api/shares/requests", Some(&abb), None).await;
    let request_id = incoming[0]["id"].as_str().unwrap().to_string();
    let (status, v) = send(
        &app,
        "POST",
        &format!("/api/shares/requests/{request_id}/accept"),
        Some(&abb),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "accept across the collation boundary: {v}"
    );

    // Both directions list the share (the row survived the CHECK).
    let (_, shares) = send(&app, "GET", "/api/shares", Some(&abc), None).await;
    assert_eq!(shares[0]["user_id"], uid("abb"));
    let (_, shares) = send(&app, "GET", "/api/shares", Some(&abb), None).await;
    assert_eq!(shares[0]["user_id"], uid("ab-c"));
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM user_shares").await, 1);
}

/// After a share is severed, a fresh request must reopen a pending row the
/// target can see — unshare is reversible (H2). The old bug treated any
/// historical request row (accepted/rejected) as "already requested" and
/// silently no-op'd forever.
#[sqlx::test]
async fn reshare_after_delete_creates_fresh_pending(pool: PgPool) {
    let app = app(&pool, true);
    let alice = user(&pool, "alice").await;
    let bob = user(&pool, "bob").await;

    // request -> accept -> share.
    send(
        &app,
        "POST",
        "/api/shares/request",
        Some(&alice),
        Some(json!({ "to_user_id": uid("bob") })),
    )
    .await;
    let (_, incoming) = send(&app, "GET", "/api/shares/requests", Some(&bob), None).await;
    let req_id = incoming[0]["id"].as_str().unwrap().to_string();
    send(
        &app,
        "POST",
        &format!("/api/shares/requests/{req_id}/accept"),
        Some(&bob),
        None,
    )
    .await;
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM user_shares").await, 1);

    // Sever it: the share AND the request row (now 'accepted') are cleared.
    let (status, _) = send(
        &app,
        "DELETE",
        &format!("/api/shares/{}", uid("bob")),
        Some(&alice),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM user_shares").await, 0);
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM share_requests").await, 0);

    // Re-request: a fresh pending row exists and bob sees it again.
    let (status, _) = send(
        &app,
        "POST",
        "/api/shares/request",
        Some(&alice),
        Some(json!({ "to_user_id": uid("bob") })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        count(
            &pool,
            "SELECT COUNT(*) FROM share_requests WHERE status = 'pending'",
        )
        .await,
        1
    );
    let (_, incoming) = send(&app, "GET", "/api/shares/requests", Some(&bob), None).await;
    assert_eq!(incoming.as_array().unwrap().len(), 1);
    assert_eq!(incoming[0]["from_user_id"], uid("alice"));
}

// ---------------------------------------------------------------------------
// temporary shares
// ---------------------------------------------------------------------------

#[sqlx::test]
async fn temp_share_lifecycle(pool: PgPool) {
    let app = app(&pool, true);
    let alice = user(&pool, "alice").await;
    let bob = user(&pool, "bob").await;
    let carol = user(&pool, "carol").await;

    // Bounds: 0 and >7d rejected, junk precision rejected.
    for bad in [
        json!({ "to_user_id": uid("bob"), "duration_minutes": 0 }),
        json!({ "to_user_id": uid("bob"), "duration_minutes": 10081 }),
        json!({ "to_user_id": uid("bob"), "duration_minutes": 60, "precision": "<EXACT>" }),
        json!({ "to_user_id": uid("alice"), "duration_minutes": 60 }),
    ] {
        let (status, _) = send(&app, "POST", "/api/shares/temp", Some(&alice), Some(bad)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    let (status, created) = send(
        &app,
        "POST",
        "/api/shares/temp",
        Some(&alice),
        Some(json!({ "to_user_id": uid("bob"), "duration_minutes": 60 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["precision"], "exact");
    let temp_id = created["id"].as_str().unwrap().to_string();

    // Nonexistent target: identical shape, nothing stored.
    let (status, ghost) = send(
        &app,
        "POST",
        "/api/shares/temp",
        Some(&alice),
        Some(json!({ "to_user_id": uid("nobody"), "duration_minutes": 60 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(ghost["id"].is_string() && ghost["expires_at"].is_string());
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM temporary_shares").await,
        1
    );

    // Visible to both parties, invisible to third parties.
    for (token, expected) in [(&alice, 1), (&bob, 1), (&carol, 0)] {
        let (status, list) = send(&app, "GET", "/api/shares/temp", Some(token), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(list.as_array().unwrap().len(), expected);
    }

    // An already-expired row (inserted directly) is filtered out of listings.
    sqlx::query(
        "INSERT INTO temporary_shares (from_user_id, to_user_id, expires_at)
         VALUES ($1, $2, now() - interval '1 hour')",
    )
    .bind(uid("bob"))
    .bind(uid("alice"))
    .execute(&pool)
    .await
    .unwrap();
    let (_, list) = send(&app, "GET", "/api/shares/temp", Some(&alice), None).await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["id"], temp_id.as_str());

    // Only the sharer may revoke; the recipient gets the same 404 as a
    // nonexistent id.
    let path = format!("/api/shares/temp/{temp_id}");
    let (status, _) = send(&app, "DELETE", &path, Some(&bob), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = send(&app, "DELETE", &path, Some(&alice), None).await;
    assert_eq!(status, StatusCode::OK);
    let (_, list) = send(&app, "GET", "/api/shares/temp", Some(&bob), None).await;
    assert_eq!(list.as_array().unwrap().len(), 0);
}

// ---------------------------------------------------------------------------
// groups
// ---------------------------------------------------------------------------

async fn create_group(app: &Router, token: &str, name: &str) -> String {
    let (status, v) = send(
        app,
        "POST",
        "/api/groups",
        Some(token),
        Some(json!({ "name": name })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    v["id"].as_str().unwrap().to_string()
}

#[sqlx::test]
async fn group_create_invite_join(pool: PgPool) {
    let app = app(&pool, true);
    let alice = user(&pool, "alice").await;
    let bob = user(&pool, "bob").await;
    let carol = user(&pool, "carol").await;

    // Names go through the display-name sanitizer; nothing left -> 400.
    let (status, v) = send(
        &app,
        "POST",
        "/api/groups",
        Some(&alice),
        Some(json!({ "name": "<b>Family</b>\u{202E}" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["name"], "bFamily/b");
    let group_id = v["id"].as_str().unwrap().to_string();
    let (status, _) = send(
        &app,
        "POST",
        "/api/groups",
        Some(&alice),
        Some(json!({ "name": "<>&\u{200B}" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Creator is an admin member of a 1-member group.
    let (status, mine) = send(&app, "GET", "/api/groups", Some(&alice), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(mine.as_array().unwrap().len(), 1);
    assert_eq!(mine[0]["role"], "admin");
    assert_eq!(mine[0]["member_count"], 1);
    assert_eq!(mine[0]["owner_id"], uid("alice"));

    // Single-use invite: bob joins, carol is refused (exhausted == invalid).
    let invite_path = format!("/api/groups/{group_id}/invite");
    let (status, invite) = send(
        &app,
        "POST",
        &invite_path,
        Some(&alice),
        Some(json!({ "max_uses": 1 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{invite}");
    let code = invite["code"].as_str().unwrap().to_string();
    assert_eq!(code.len(), 8);

    let (status, joined) = send(
        &app,
        "POST",
        &format!("/api/groups/join/{code}"),
        Some(&bob),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{joined}");
    assert_eq!(joined["group_id"], group_id.as_str());
    let (status, _) = send(
        &app,
        "POST",
        &format!("/api/groups/join/{code}"),
        Some(&carol),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Expired invites are refused; re-joining on a valid code is an idempotent
    // success that does not burn a use.
    sqlx::query(
        "INSERT INTO group_invites (group_id, code, created_by, max_uses, expires_at)
         VALUES ($1::uuid, 'EXPIRED2', $2, 0, now() - interval '1 minute')",
    )
    .bind(&group_id)
    .bind(uid("alice"))
    .execute(&pool)
    .await
    .unwrap();
    let (status, _) = send(
        &app,
        "POST",
        "/api/groups/join/EXPIRED2",
        Some(&carol),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (_, invite2) = send(&app, "POST", &invite_path, Some(&alice), Some(json!({}))).await;
    let code2 = invite2["code"].as_str().unwrap().to_string();
    let (status, _) = send(
        &app,
        "POST",
        &format!("/api/groups/join/{code2}"),
        Some(&bob),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (uses,): (i32,) = sqlx::query_as("SELECT uses FROM group_invites WHERE code = $1")
        .bind(&code2)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(uses, 0, "re-join must not consume invite uses");

    // Member-only visibility: carol (non-member) sees the same 404 as a
    // nonexistent group id.
    let group_path = format!("/api/groups/{group_id}");
    let (status, detail) = send(&app, "GET", &group_path, Some(&bob), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(detail["members"].as_array().unwrap().len(), 2);
    let (status, _) = send(&app, "GET", &group_path, Some(&carol), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = send(
        &app,
        "GET",
        &format!("/api/groups/{}", Uuid::new_v4()),
        Some(&carol),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Plain members can't mint invites until members_can_invite is on, and
    // only admins may flip it.
    let (status, _) = send(&app, "POST", &invite_path, Some(&bob), Some(json!({}))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let settings_path = format!("/api/groups/{group_id}/settings");
    let (status, _) = send(
        &app,
        "PUT",
        &settings_path,
        Some(&bob),
        Some(json!({ "members_can_invite": true })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = send(
        &app,
        "PUT",
        &settings_path,
        Some(&alice),
        Some(json!({ "members_can_invite": true, "name": "Fam" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, detail) = send(&app, "GET", &group_path, Some(&alice), None).await;
    assert_eq!(detail["name"], "Fam");
    assert_eq!(detail["members_can_invite"], true);
    let (status, _) = send(&app, "POST", &invite_path, Some(&bob), Some(json!({}))).await;
    assert_eq!(status, StatusCode::OK);
}

#[sqlx::test]
async fn group_membership_roles_and_removal(pool: PgPool) {
    let app = app(&pool, true);
    let alice = user(&pool, "alice").await;
    let bob = user(&pool, "bob").await;
    let carol = user(&pool, "carol").await;
    let group_id = create_group(&app, &alice, "Crew").await;
    sqlx::query("INSERT INTO group_members (group_id, user_id) VALUES ($1::uuid, $2)")
        .bind(&group_id)
        .bind(uid("bob"))
        .execute(&pool)
        .await
        .unwrap();

    // Direct-add requires an accepted share with the ADDER (privacy: only
    // people who already share with you can be pulled into a group), and the
    // no-share and no-such-user failures are indistinguishable.
    let members_path = format!("/api/groups/{group_id}/members");
    let (status, no_share) = send(
        &app,
        "POST",
        &members_path,
        Some(&alice),
        Some(json!({ "user_id": uid("carol") })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, no_user) = send(
        &app,
        "POST",
        &members_path,
        Some(&alice),
        Some(json!({ "user_id": uid("nobody") })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(no_share, no_user);

    seed_share(&pool, &uid("alice"), &uid("carol")).await;
    let (status, _) = send(
        &app,
        "POST",
        &members_path,
        Some(&alice),
        Some(json!({ "user_id": uid("carol") })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // Plain member bob can't direct-add (members_can_invite is off).
    let (status, _) = send(
        &app,
        "POST",
        &members_path,
        Some(&bob),
        Some(json!({ "user_id": uid("carol") })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // My membership row: opt out of broadcasting.
    let me_path = format!("/api/groups/{group_id}/me");
    let (status, _) = send(
        &app,
        "PUT",
        &me_path,
        Some(&bob),
        Some(json!({ "sharing": false, "precision": "city" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, detail) = send(
        &app,
        "GET",
        &format!("/api/groups/{group_id}"),
        Some(&alice),
        None,
    )
    .await;
    let bob_row = detail["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["user_id"] == uid("bob"))
        .unwrap();
    assert_eq!(bob_row["sharing"], false);
    // Non-members have no membership row to edit.
    let (status, _) = send(
        &app,
        "PUT",
        &me_path,
        Some(&user(&pool, "dave").await),
        Some(json!({ "sharing": false })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Roles: admin-only, member|admin only, owner's role immutable.
    let role_path = |target: &str| format!("/api/groups/{group_id}/members/{target}/role");
    let (status, _) = send(
        &app,
        "PUT",
        &role_path(&uid("carol")),
        Some(&bob),
        Some(json!({ "role": "admin" })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = send(
        &app,
        "PUT",
        &role_path(&uid("carol")),
        Some(&alice),
        Some(json!({ "role": "owner" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = send(
        &app,
        "PUT",
        &role_path(&uid("alice")),
        Some(&alice),
        Some(json!({ "role": "member" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = send(
        &app,
        "PUT",
        &role_path(&uid("carol")),
        Some(&alice),
        Some(json!({ "role": "admin" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Removal: members can't kick; admins can; self-leave always works; the
    // owner can't be kicked and can't leave while others remain.
    let member_path = |target: &str| format!("/api/groups/{group_id}/members/{target}");
    let (status, _) = send(
        &app,
        "DELETE",
        &member_path(&uid("carol")),
        Some(&bob),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = send(
        &app,
        "DELETE",
        &member_path(&uid("alice")),
        Some(&carol),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, v) = send(
        &app,
        "DELETE",
        &member_path(&uid("alice")),
        Some(&alice),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(v["error"].as_str().unwrap().contains("owner"), "{v}");
    let (status, _) = send(
        &app,
        "DELETE",
        &member_path(&uid("bob")),
        Some(&carol),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(
        &app,
        "DELETE",
        &member_path(&uid("carol")),
        Some(&carol),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Alone now: the owner leaving deletes the group entirely.
    let (status, _) = send(
        &app,
        "DELETE",
        &member_path(&uid("alice")),
        Some(&alice),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM groups").await, 0);

    // DELETE /api/groups/{id}: member-but-not-owner is forbidden; owner wins.
    let group2 = create_group(&app, &alice, "Two").await;
    sqlx::query("INSERT INTO group_members (group_id, user_id) VALUES ($1::uuid, $2)")
        .bind(&group2)
        .bind(uid("bob"))
        .execute(&pool)
        .await
        .unwrap();
    let (status, _) = send(
        &app,
        "DELETE",
        &format!("/api/groups/{group2}"),
        Some(&bob),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = send(
        &app,
        "DELETE",
        &format!("/api/groups/{group2}"),
        Some(&alice),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM group_members").await, 0);
}

#[sqlx::test]
async fn group_join_rate_limit(pool: PgPool) {
    let app = app(&pool, true);
    let alice = user(&pool, "alice").await;

    // 5/min per user, counted before code validation (brute-force guard).
    for i in 1..=5 {
        let (status, _) = send(
            &app,
            "POST",
            "/api/groups/join/WRONGCOD",
            Some(&alice),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "attempt {i}");
    }
    let (status, _) = send(
        &app,
        "POST",
        "/api/groups/join/WRONGCOD",
        Some(&alice),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
}

// ---------------------------------------------------------------------------
// ghost
// ---------------------------------------------------------------------------

#[sqlx::test]
async fn ghost_toggle_and_targets(pool: PgPool) {
    let app = app(&pool, true);
    let alice = user(&pool, "alice").await;
    let _bob = user(&pool, "bob").await;

    let (status, v) = send(&app, "GET", "/api/ghost", Some(&alice), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v, json!({ "active": false, "targets": [] }));

    let (status, v) = send(
        &app,
        "PUT",
        "/api/ghost",
        Some(&alice),
        Some(json!({ "active": true })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v, json!({ "active": true }));

    // Per-target add; ghosting a nonexistent user is a silent no-op with the
    // identical response (enumeration-safe).
    let (status, _) = send(
        &app,
        "PUT",
        "/api/ghost/targets",
        Some(&alice),
        Some(json!({ "user_id": uid("bob"), "ghosted": true })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(
        &app,
        "PUT",
        "/api/ghost/targets",
        Some(&alice),
        Some(json!({ "user_id": uid("nobody"), "ghosted": true })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(
        &app,
        "PUT",
        "/api/ghost/targets",
        Some(&alice),
        Some(json!({ "user_id": uid("alice"), "ghosted": true })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (_, v) = send(&app, "GET", "/api/ghost", Some(&alice), None).await;
    assert_eq!(v, json!({ "active": true, "targets": [uid("bob")] }));

    // Remove target + global off.
    let (status, _) = send(
        &app,
        "PUT",
        "/api/ghost/targets",
        Some(&alice),
        Some(json!({ "user_id": uid("bob"), "ghosted": false })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(
        &app,
        "PUT",
        "/api/ghost",
        Some(&alice),
        Some(json!({ "active": false })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, v) = send(&app, "GET", "/api/ghost", Some(&alice), None).await;
    assert_eq!(v, json!({ "active": false, "targets": [] }));
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

async fn person_entity(pool: &PgPool, user_id: &str) -> Uuid {
    let (id,): (Uuid,) =
        sqlx::query_as("SELECT id FROM entities WHERE owner_id = $1 AND kind = 'person'")
            .bind(user_id)
            .fetch_one(pool)
            .await
            .unwrap();
    id
}

async fn insert_history(pool: &PgPool, entity: Uuid, rtype: &str, rid: &str, ts: i64, blob: &[u8]) {
    sqlx::query(
        "INSERT INTO location_history (entity_id, recipient_type, recipient_id, encrypted_blob,
                                       client_timestamp)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(entity)
    .bind(rtype)
    .bind(rid)
    .bind(blob)
    .bind(ts)
    .execute(pool)
    .await
    .unwrap();
}

#[sqlx::test]
async fn history_scoped_to_viewer_audiences(pool: PgPool) {
    let app = app(&pool, true);
    let alice = user(&pool, "alice").await;
    let bob = user(&pool, "bob").await;
    let carol = user(&pool, "carol").await;

    // No relationship yet -> 404 (deliberately NOT 403: a 403 would confirm
    // the account exists; 404 matches the nonexistent-user response). History
    // rows encrypted for bob (inserted below) change nothing without a
    // *current* relationship.
    let path = format!("/api/history/{}", uid("alice"));
    let (status, _) = send(&app, "GET", &path, Some(&bob), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = send(
        &app,
        "GET",
        &format!("/api/history/{}", uid("nobody")),
        Some(&bob),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Alice broadcasts into a group bob is in, plus direct user-audience rows.
    let group_id = create_group(&app, &alice, "Crew").await;
    sqlx::query("INSERT INTO group_members (group_id, user_id) VALUES ($1::uuid, $2)")
        .bind(&group_id)
        .bind(uid("bob"))
        .execute(&pool)
        .await
        .unwrap();
    let alice_entity = person_entity(&pool, &uid("alice")).await;
    insert_history(&pool, alice_entity, "user", &uid("bob"), 1000, b"for-bob-1").await;
    insert_history(
        &pool,
        alice_entity,
        "user",
        &uid("carol"),
        1500,
        b"for-carol",
    )
    .await;
    insert_history(&pool, alice_entity, "user", &uid("bob"), 2000, b"for-bob-2").await;
    insert_history(&pool, alice_entity, "group", &group_id, 3000, b"for-group").await;

    // With a share, bob gets exactly his audiences: his user rows + the group
    // row (alice is broadcasting), newest first, blobs base64.
    seed_share(&pool, &uid("alice"), &uid("bob")).await;
    let (status, rows) = send(&app, "GET", &path, Some(&bob), None).await;
    assert_eq!(status, StatusCode::OK);
    let rows = rows.as_array().unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0]["client_timestamp"], 3000);
    assert_eq!(rows[0]["recipient_type"], "group");
    assert_eq!(rows[0]["encrypted_blob"], BASE64.encode(b"for-group"));
    assert_eq!(rows[2]["client_timestamp"], 1000);
    assert_eq!(rows[2]["encrypted_blob"], BASE64.encode(b"for-bob-1"));

    // since + limit.
    let (_, rows) = send(&app, "GET", &format!("{path}?since=1500"), Some(&bob), None).await;
    assert_eq!(rows.as_array().unwrap().len(), 2);
    let (_, rows) = send(&app, "GET", &format!("{path}?limit=1"), Some(&bob), None).await;
    assert_eq!(rows.as_array().unwrap().len(), 1);
    assert_eq!(rows[0]["client_timestamp"], 3000);

    // Carol via an active temp share from alice: only her user-audience row —
    // the group row stays invisible (she is not a member).
    sqlx::query(
        "INSERT INTO temporary_shares (from_user_id, to_user_id, expires_at)
         VALUES ($1, $2, now() + interval '1 hour')",
    )
    .bind(uid("alice"))
    .bind(uid("carol"))
    .execute(&pool)
    .await
    .unwrap();
    let (status, rows) = send(&app, "GET", &path, Some(&carol), None).await;
    assert_eq!(status, StatusCode::OK);
    let rows = rows.as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["recipient_id"], uid("carol"));

    // If alice stops broadcasting into the group, bob loses the group row.
    sqlx::query(
        "UPDATE group_members SET sharing = FALSE WHERE group_id = $1::uuid AND user_id = $2",
    )
    .bind(&group_id)
    .bind(uid("alice"))
    .execute(&pool)
    .await
    .unwrap();
    let (_, rows) = send(&app, "GET", &path, Some(&bob), None).await;
    assert_eq!(rows.as_array().unwrap().len(), 2);

    // Ghost hides history from the viewer entirely (same 404).
    sqlx::query("UPDATE users SET ghost_active = TRUE WHERE id = $1")
        .bind(uid("alice"))
        .execute(&pool)
        .await
        .unwrap();
    let (status, _) = send(&app, "GET", &path, Some(&bob), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Own history: everything, ghost or not. Wipe deletes only my rows.
    let (status, rows) = send(&app, "GET", &path, Some(&alice), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rows.as_array().unwrap().len(), 4);
    let (status, v) = send(&app, "DELETE", "/api/history", Some(&alice), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["deleted"], 4);
    let (_, rows) = send(&app, "GET", &path, Some(&alice), None).await;
    assert_eq!(rows.as_array().unwrap().len(), 0);
}

/// A client walking a large window forward by advancing `since` to the last
/// timestamp it saw must eventually see EVERY row, never skipping the middle
/// (M8). With since>0 the server returns the oldest rows above the cursor in
/// ascending order; repeated small pages cover the whole trail.
#[sqlx::test]
async fn history_forward_walk_pages_everything(pool: PgPool) {
    let app = app(&pool, true);
    let _alice = user(&pool, "alice").await;
    let bob = user(&pool, "bob").await;
    seed_share(&pool, &uid("alice"), &uid("bob")).await;

    let alice_entity = person_entity(&pool, &uid("alice")).await;
    let all_ts = [1000_i64, 2000, 3000, 4000, 5000];
    for ts in all_ts {
        insert_history(&pool, alice_entity, "user", &uid("bob"), ts, b"fix").await;
    }

    // bob (viewer) walks alice's (target) history, scoped to his own audience.
    let path = format!("/api/history/{}", uid("alice"));
    // Walk forward from a cursor below the first row (since>0 => ascending).
    let mut since = 1_i64;
    let mut seen: Vec<i64> = Vec::new();
    for _ in 0..10 {
        let (status, rows) = send(
            &app,
            "GET",
            &format!("{path}?since={since}&limit=2"),
            Some(&bob),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let rows = rows.as_array().unwrap();
        if rows.is_empty() {
            break;
        }
        // Each page is ascending and strictly beyond the cursor.
        let page: Vec<i64> = rows
            .iter()
            .map(|r| r["client_timestamp"].as_i64().unwrap())
            .collect();
        assert!(
            page.windows(2).all(|w| w[0] < w[1]),
            "page not ascending: {page:?}"
        );
        assert!(page[0] > since, "page did not advance past the cursor");
        since = *page.last().unwrap();
        seen.extend(page);
    }
    // Every row surfaced exactly once, in order, across the pages.
    assert_eq!(seen, all_ts, "forward walk missed or duplicated rows");
}

// ---------------------------------------------------------------------------
// authz gate, called directly against seeded data (D-005)
// ---------------------------------------------------------------------------

#[sqlx::test]
async fn authz_ghost_blocks_delivery(pool: PgPool) {
    for u in ["a", "b", "c"] {
        seed_user(&pool, u).await;
    }
    seed_share(&pool, "a", "b").await;
    seed_share(&pool, "a", "c").await;

    assert!(authz::can_deliver_to_user(&pool, "a", "b").await.unwrap());

    // Global ghost: nothing to anyone — except yourself.
    sqlx::query("UPDATE users SET ghost_active = TRUE WHERE id = 'a'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(!authz::can_deliver_to_user(&pool, "a", "b").await.unwrap());
    assert!(!authz::can_deliver_to_user(&pool, "a", "c").await.unwrap());
    assert!(authz::can_deliver_to_user(&pool, "a", "a").await.unwrap());
    // Viewer side is blocked too.
    assert!(!authz::can_view(&pool, "b", "a").await.unwrap());
    sqlx::query("UPDATE users SET ghost_active = FALSE WHERE id = 'a'")
        .execute(&pool)
        .await
        .unwrap();

    // Per-target ghost blocks exactly that target.
    sqlx::query("INSERT INTO ghost_targets (user_id, target_user_id) VALUES ('a', 'b')")
        .execute(&pool)
        .await
        .unwrap();
    assert!(!authz::can_deliver_to_user(&pool, "a", "b").await.unwrap());
    assert!(authz::can_deliver_to_user(&pool, "a", "c").await.unwrap());
    assert!(!authz::can_view(&pool, "b", "a").await.unwrap());
    assert!(authz::can_view(&pool, "c", "a").await.unwrap());
    // The ghosted party's own outbound is unaffected (shares are symmetric,
    // ghost is not).
    assert!(authz::can_deliver_to_user(&pool, "b", "a").await.unwrap());
}

#[sqlx::test]
async fn authz_temp_share_directional_until_expiry(pool: PgPool) {
    seed_user(&pool, "a").await;
    seed_user(&pool, "b").await;
    sqlx::query(
        "INSERT INTO temporary_shares (from_user_id, to_user_id, expires_at)
         VALUES ('a', 'b', now() + interval '1 hour')",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Directional: a may deliver to b (and b may view a), never the reverse.
    assert!(authz::can_deliver_to_user(&pool, "a", "b").await.unwrap());
    assert!(!authz::can_deliver_to_user(&pool, "b", "a").await.unwrap());
    assert!(authz::can_view(&pool, "b", "a").await.unwrap());
    assert!(!authz::can_view(&pool, "a", "b").await.unwrap());

    // Expiry ends it immediately.
    sqlx::query("UPDATE temporary_shares SET expires_at = now() - interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(!authz::can_deliver_to_user(&pool, "a", "b").await.unwrap());
    assert!(!authz::can_view(&pool, "b", "a").await.unwrap());
}

#[sqlx::test]
async fn authz_group_fanout_rules(pool: PgPool) {
    for u in ["a", "b", "c", "d"] {
        seed_user(&pool, u).await;
    }
    let (group_id,): (Uuid,) =
        sqlx::query_as("INSERT INTO groups (name, owner_id) VALUES ('g', 'a') RETURNING id")
            .fetch_one(&pool)
            .await
            .unwrap();
    for u in ["a", "b", "c"] {
        sqlx::query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)")
            .bind(group_id)
            .bind(u)
            .execute(&pool)
            .await
            .unwrap();
    }
    let gid = group_id.to_string();

    // Member with sharing on fans out to the other members, never itself.
    let mut recipients = authz::group_fanout_recipients(&pool, "a", &gid)
        .await
        .unwrap();
    recipients.sort();
    assert_eq!(recipients, vec!["b".to_string(), "c".to_string()]);

    // Non-member sender: empty.
    assert!(authz::group_fanout_recipients(&pool, "d", &gid)
        .await
        .unwrap()
        .is_empty());

    // sharing=false sender: empty.
    sqlx::query("UPDATE group_members SET sharing = FALSE WHERE group_id = $1 AND user_id = 'a'")
        .bind(group_id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(authz::group_fanout_recipients(&pool, "a", &gid)
        .await
        .unwrap()
        .is_empty());
    sqlx::query("UPDATE group_members SET sharing = TRUE WHERE group_id = $1 AND user_id = 'a'")
        .bind(group_id)
        .execute(&pool)
        .await
        .unwrap();

    // Per-target-ghosted members are filtered from the fan-out.
    sqlx::query("INSERT INTO ghost_targets (user_id, target_user_id) VALUES ('a', 'c')")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        authz::group_fanout_recipients(&pool, "a", &gid)
            .await
            .unwrap(),
        vec!["b".to_string()]
    );

    // Global ghost empties it.
    sqlx::query("UPDATE users SET ghost_active = TRUE WHERE id = 'a'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(authz::group_fanout_recipients(&pool, "a", &gid)
        .await
        .unwrap()
        .is_empty());
}

#[sqlx::test]
async fn authz_can_view_group_requires_target_broadcasting(pool: PgPool) {
    seed_user(&pool, "a").await;
    seed_user(&pool, "b").await;
    let (group_id,): (Uuid,) =
        sqlx::query_as("INSERT INTO groups (name, owner_id) VALUES ('g', 'a') RETURNING id")
            .fetch_one(&pool)
            .await
            .unwrap();
    for u in ["a", "b"] {
        sqlx::query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)")
            .bind(group_id)
            .bind(u)
            .execute(&pool)
            .await
            .unwrap();
    }

    // Shared group + target broadcasting -> viewable.
    assert!(authz::can_view(&pool, "b", "a").await.unwrap());

    // Target flips sharing off in that group -> no longer viewable.
    sqlx::query("UPDATE group_members SET sharing = FALSE WHERE group_id = $1 AND user_id = 'a'")
        .bind(group_id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(!authz::can_view(&pool, "b", "a").await.unwrap());
    // The viewer's own sharing flag is irrelevant to what they may VIEW: b
    // still can't see a, and a can see b (b still broadcasts).
    assert!(authz::can_view(&pool, "a", "b").await.unwrap());
}
