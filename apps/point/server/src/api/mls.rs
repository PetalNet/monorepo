//! MLS delivery service: the one-time KeyPackage pool with a last-resort
//! fallback (D-007 — legacy served every package to every fetcher forever,
//! the silent-member-drop root cause) and the welcome/commit ciphertext
//! mailbox. Every payload here is opaque bytes; the server never parses MLS.
//!
//! Authz answers 404, never 403, on deny — a 403 would confirm the target
//! account exists (same rule as history).

use std::collections::HashSet;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::{Extension, Json};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::authz;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;

use super::rate_limit::RateLimiter;

/// Legacy caps kept: ≤2KB per decoded package, ≤5 per upload. The stored pool
/// cap is raised 10 → 20 since packages are now actually consumed (D-007).
const MAX_KEY_PACKAGE_BYTES: usize = 2048;
const MAX_UPLOAD_BATCH: usize = 5;
const MAX_STORED_UNCONSUMED: i64 = 20;
/// Welcome/commit payloads grow with group size; 256KB is far beyond v1 needs.
const MAX_MLS_PAYLOAD_BYTES: usize = 256 * 1024;
/// Cap explicit commit fan-out lists.
const MAX_COMMIT_RECIPIENTS: usize = 256;
/// Ceiling on a recipient's unprocessed mailbox: a client that never acks (or
/// a hostile sender) can't grow it without bound. New welcome/commit rows are
/// refused with 429 once the backlog hits this.
const MAX_UNPROCESSED_PER_RECIPIENT: i64 = 500;

/// Per-user write/claim budgets (fixed 60s windows, shared limiter).
const MLS_CLAIM_PER_MINUTE: u32 = 60;
const MLS_WELCOME_PER_MINUTE: u32 = 60;
const MLS_COMMIT_PER_MINUTE: u32 = 30;

fn decode_b64(s: &str, max: usize, what: &str) -> Result<Vec<u8>, AppError> {
    let bytes = BASE64
        .decode(s)
        .map_err(|_| AppError::BadRequest(format!("{what}: invalid base64")))?;
    if bytes.is_empty() || bytes.len() > max {
        return Err(AppError::BadRequest(format!("{what}: invalid size")));
    }
    Ok(bytes)
}

// ---------------------------------------------------------------------------
// KeyPackages
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct UploadKeysBody {
    #[serde(default)]
    pub key_packages: Vec<String>,
    /// THE last-resort package: at most one per user, replaced on re-upload,
    /// returned (never consumed) only when the regular pool is dry.
    pub last_resort: Option<String>,
}

/// POST /api/mls/keys — top up my one-time KeyPackage pool and/or replace my
/// last-resort package.
pub async fn upload_keys(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<UploadKeysBody>,
) -> ApiResult<Json<Value>> {
    if body.key_packages.len() > MAX_UPLOAD_BATCH {
        return Err(AppError::BadRequest(
            "too many key packages (max 5 per upload)".into(),
        ));
    }
    if body.key_packages.is_empty() && body.last_resort.is_none() {
        return Err(AppError::BadRequest("no key packages provided".into()));
    }
    let regular: Vec<Vec<u8>> = body
        .key_packages
        .iter()
        .map(|s| decode_b64(s, MAX_KEY_PACKAGE_BYTES, "key package"))
        .collect::<Result<_, _>>()?;
    let last_resort = body
        .last_resort
        .as_deref()
        .map(|s| decode_b64(s, MAX_KEY_PACKAGE_BYTES, "last-resort package"))
        .transpose()?;

    let mut tx = state.pool.begin().await?;
    // Serialize concurrent uploads per user so the pool cap can't be raced.
    let me: Option<(i32,)> = sqlx::query_as("SELECT 1 FROM users WHERE id = $1 FOR UPDATE")
        .bind(&user.user_id)
        .fetch_optional(&mut *tx)
        .await?;
    if me.is_none() {
        return Err(AppError::Unauthorized); // mid-request account deletion
    }
    let (stored,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM key_packages
         WHERE user_id = $1 AND consumed_at IS NULL AND NOT is_last_resort",
    )
    .bind(&user.user_id)
    .fetch_one(&mut *tx)
    .await?;
    if stored + regular.len() as i64 > MAX_STORED_UNCONSUMED {
        return Err(AppError::BadRequest(
            "key package pool full (max 20 unconsumed)".into(),
        ));
    }
    for kp in &regular {
        sqlx::query("INSERT INTO key_packages (user_id, key_package) VALUES ($1, $2)")
            .bind(&user.user_id)
            .bind(kp)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(lr) = &last_resort {
        // Upsert THE last-resort package: the unique partial index allows one.
        sqlx::query("DELETE FROM key_packages WHERE user_id = $1 AND is_last_resort")
            .bind(&user.user_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT INTO key_packages (user_id, key_package, is_last_resort)
             VALUES ($1, $2, TRUE)",
        )
        .bind(&user.user_id)
        .bind(lr)
        .execute(&mut *tx)
        .await?;
    }
    let (has_last_resort,): (bool,) = sqlx::query_as(
        "SELECT EXISTS(SELECT 1 FROM key_packages WHERE user_id = $1 AND is_last_resort)",
    )
    .bind(&user.user_id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(Json(json!({
        "stored": regular.len(),
        "unconsumed": stored + regular.len() as i64,
        "has_last_resort": has_last_resort,
    })))
}

/// GET /api/mls/keys/{user_id} — NON-consuming probe of the target's pool.
/// Same authz gate as claim (unknown/no-relationship targets are the same
/// 404), but nothing is consumed: a client can safely poll this. Returns the
/// count of available one-time packages and whether a last-resort exists so
/// the caller knows whether a subsequent claim will burn a one-time package or
/// fall back. (M7: the consuming fetch is now POST .../claim, so a plain GET —
/// or a retry/proxy replay — can never silently drain the pool.)
pub async fn probe_key(
    State(state): State<AppState>,
    user: AuthUser,
    Path(target): Path<String>,
) -> ApiResult<Json<Value>> {
    let target = target.trim().to_lowercase();
    if !authz::can_fetch_key_packages(&state.pool, &user.user_id, &target).await? {
        return Err(AppError::NotFound);
    }
    let (available, has_last_resort): (i64, bool) = sqlx::query_as(
        "SELECT
             (SELECT COUNT(*) FROM key_packages
              WHERE user_id = $1 AND consumed_at IS NULL AND NOT is_last_resort),
             EXISTS(SELECT 1 FROM key_packages WHERE user_id = $1 AND is_last_resort)",
    )
    .bind(&target)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(json!({
        "available": available,
        "has_last_resort": has_last_resort,
    })))
}

/// POST /api/mls/keys/{user_id}/claim — claim ONE of the target's KeyPackages,
/// atomically consuming it (D-007). When the pool is dry, the last-resort
/// package is returned WITHOUT being consumed. `remaining` tells the owner's
/// peers nothing they can't already infer, and tells clients when to nudge a
/// replenish.
pub async fn claim_key(
    State(state): State<AppState>,
    Extension(limiter): Extension<Arc<RateLimiter>>,
    user: AuthUser,
    Path(target): Path<String>,
) -> ApiResult<Json<Value>> {
    limiter.check(&format!("mls_claim:{}", user.user_id), MLS_CLAIM_PER_MINUTE)?;
    let target = target.trim().to_lowercase();
    // Fail-closed gate; unknown targets come back "not allowed" -> same 404.
    if !authz::can_fetch_key_packages(&state.pool, &user.user_id, &target).await? {
        return Err(AppError::NotFound);
    }

    // Atomic consume: SKIP LOCKED makes concurrent fetchers take different
    // rows instead of serializing or double-serving one.
    let consumed: Option<(Vec<u8>,)> = sqlx::query_as(
        "UPDATE key_packages SET consumed_at = now()
         WHERE id = (
             SELECT id FROM key_packages
             WHERE user_id = $1 AND consumed_at IS NULL AND NOT is_last_resort
             ORDER BY created_at, id
             LIMIT 1
             FOR UPDATE SKIP LOCKED
         )
         RETURNING key_package",
    )
    .bind(&target)
    .fetch_optional(&state.pool)
    .await?;

    if let Some((kp,)) = consumed {
        let (remaining,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM key_packages
             WHERE user_id = $1 AND consumed_at IS NULL AND NOT is_last_resort",
        )
        .bind(&target)
        .fetch_one(&state.pool)
        .await?;
        return Ok(Json(json!({
            "key_package": BASE64.encode(kp),
            "last_resort": false,
            "remaining": remaining,
        })));
    }

    let last_resort: Option<(Vec<u8>,)> = sqlx::query_as(
        "SELECT key_package FROM key_packages WHERE user_id = $1 AND is_last_resort",
    )
    .bind(&target)
    .fetch_optional(&state.pool)
    .await?;
    match last_resort {
        Some((kp,)) => Ok(Json(json!({
            "key_package": BASE64.encode(kp),
            "last_resort": true,
            "remaining": 0,
        }))),
        None => Err(AppError::NotFound), // no packages at all
    }
}

/// GET /api/mls/keys/count — my own pool level, for client replenish logic.
pub async fn key_count(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    let (count, has_last_resort): (i64, bool) = sqlx::query_as(
        "SELECT
             (SELECT COUNT(*) FROM key_packages
              WHERE user_id = $1 AND consumed_at IS NULL AND NOT is_last_resort),
             EXISTS(SELECT 1 FROM key_packages WHERE user_id = $1 AND is_last_resort)",
    )
    .bind(&user.user_id)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(
        json!({ "count": count, "has_last_resort": has_last_resort }),
    ))
}

// ---------------------------------------------------------------------------
// welcome / commit mailbox
// ---------------------------------------------------------------------------

fn validate_group_id(group_id: &str) -> Result<(), AppError> {
    if group_id.is_empty() || group_id.len() > 128 {
        return Err(AppError::BadRequest("invalid group_id".into()));
    }
    Ok(())
}

/// Insert one mailbox row inside `tx`, enforcing the per-recipient backlog cap
/// first. Returns the new id + created_at so the caller can live-push AFTER the
/// transaction commits (a push before commit could race a rollback).
async fn insert_mailbox(
    tx: &mut Transaction<'_, Postgres>,
    sender: &str,
    recipient: &str,
    message_type: &str,
    group_id: &str,
    payload: &[u8],
) -> Result<(Uuid, DateTime<Utc>), AppError> {
    let (pending,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM mls_messages WHERE recipient_id = $1 AND NOT processed",
    )
    .bind(recipient)
    .fetch_one(&mut **tx)
    .await?;
    if pending >= MAX_UNPROCESSED_PER_RECIPIENT {
        return Err(AppError::TooManyRequests);
    }
    let row: (Uuid, DateTime<Utc>) = sqlx::query_as(
        "INSERT INTO mls_messages (recipient_id, sender_id, message_type, group_id, payload)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, created_at",
    )
    .bind(recipient)
    .bind(sender)
    .bind(message_type)
    .bind(group_id)
    .bind(payload)
    .fetch_one(&mut **tx)
    .await?;
    Ok(row)
}

/// Live-push a stored mailbox row to the recipient's connections (best effort;
/// zero connections is fine — it's in the mailbox for the next poll).
#[allow(clippy::too_many_arguments)]
fn push_mailbox(
    state: &AppState,
    id: Uuid,
    created_at: DateTime<Utc>,
    sender: &str,
    recipient: &str,
    message_type: &str,
    group_id: &str,
    payload: &[u8],
) {
    let push = json!({
        "type": "mls.message",
        "id": id,
        "message_type": message_type,
        "group_id": group_id,
        "sender_id": sender,
        "payload": BASE64.encode(payload),
        "created_at": created_at.to_rfc3339(),
    })
    .to_string();
    state.hub.send_to_user(recipient, &push);
}

#[derive(Deserialize)]
pub struct WelcomeBody {
    pub recipient_id: String,
    pub group_id: String,
    pub payload: String,
}

/// POST /api/mls/welcome — relay an MLS Welcome to one recipient. Same trust
/// basis as fetching their KeyPackage (you can only Welcome someone whose
/// KeyPackage you could obtain). Unknown recipient and no-relationship
/// recipient are the same 404.
pub async fn send_welcome(
    State(state): State<AppState>,
    Extension(limiter): Extension<Arc<RateLimiter>>,
    user: AuthUser,
    Json(body): Json<WelcomeBody>,
) -> ApiResult<Json<Value>> {
    limiter.check(
        &format!("mls_welcome:{}", user.user_id),
        MLS_WELCOME_PER_MINUTE,
    )?;
    validate_group_id(&body.group_id)?;
    let payload = decode_b64(&body.payload, MAX_MLS_PAYLOAD_BYTES, "payload")?;
    let recipient = body.recipient_id.trim().to_lowercase();

    let exists: Option<(i32,)> = sqlx::query_as("SELECT 1 FROM users WHERE id = $1")
        .bind(&recipient)
        .fetch_optional(&state.pool)
        .await?;
    if exists.is_none()
        || !authz::can_fetch_key_packages(&state.pool, &user.user_id, &recipient).await?
    {
        return Err(AppError::NotFound);
    }

    let mut tx = state.pool.begin().await?;
    let (id, created_at) = insert_mailbox(
        &mut tx,
        &user.user_id,
        &recipient,
        "welcome",
        &body.group_id,
        &payload,
    )
    .await?;
    tx.commit().await?;
    push_mailbox(
        &state,
        id,
        created_at,
        &user.user_id,
        &recipient,
        "welcome",
        &body.group_id,
        &payload,
    );
    Ok(Json(json!({ "id": id, "ok": true })))
}

#[derive(Deserialize)]
pub struct CommitBody {
    pub group_id: String,
    pub payload: String,
    /// Explicit fan-out (pairwise/DM MLS groups whose id is not a server
    /// group). Omitted = fan to the server group's current members.
    pub recipient_ids: Option<Vec<String>>,
}

/// POST /api/mls/commit — relay an MLS Commit to the group's members (server
/// group id) or an explicit recipient list (pairwise ids). Fail closed: with
/// an explicit list, EVERY recipient must pass the relationship gate or the
/// whole request is refused — a commit silently skipping members would desync
/// the MLS group.
pub async fn send_commit(
    State(state): State<AppState>,
    Extension(limiter): Extension<Arc<RateLimiter>>,
    user: AuthUser,
    Json(body): Json<CommitBody>,
) -> ApiResult<Json<Value>> {
    limiter.check(
        &format!("mls_commit:{}", user.user_id),
        MLS_COMMIT_PER_MINUTE,
    )?;
    validate_group_id(&body.group_id)?;
    let payload = decode_b64(&body.payload, MAX_MLS_PAYLOAD_BYTES, "payload")?;

    let recipients: Vec<String> = match body.recipient_ids {
        Some(ids) => {
            if ids.is_empty() || ids.len() > MAX_COMMIT_RECIPIENTS {
                return Err(AppError::BadRequest("invalid recipient_ids".into()));
            }
            let mut seen = HashSet::new();
            let mut out = Vec::new();
            for raw in ids {
                let r = raw.trim().to_lowercase();
                if r == user.user_id || !seen.insert(r.clone()) {
                    continue; // own devices resync via the group state, not the mailbox
                }
                let exists: Option<(i32,)> = sqlx::query_as("SELECT 1 FROM users WHERE id = $1")
                    .bind(&r)
                    .fetch_optional(&state.pool)
                    .await?;
                if exists.is_none()
                    || !authz::can_fetch_key_packages(&state.pool, &user.user_id, &r).await?
                {
                    return Err(AppError::NotFound);
                }
                out.push(r);
            }
            out
        }
        None => {
            // group_id must be a real server group and the sender a member.
            let Ok(gid) = Uuid::parse_str(&body.group_id) else {
                return Err(AppError::BadRequest("unknown group".into()));
            };
            let group: Option<(i32,)> = sqlx::query_as("SELECT 1 FROM groups WHERE id = $1")
                .bind(gid)
                .fetch_optional(&state.pool)
                .await?;
            if group.is_none() {
                return Err(AppError::BadRequest("unknown group".into()));
            }
            let member: Option<(i32,)> =
                sqlx::query_as("SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2")
                    .bind(gid)
                    .bind(&user.user_id)
                    .fetch_optional(&state.pool)
                    .await?;
            if member.is_none() {
                return Err(AppError::NotFound); // non-members can't probe groups
            }
            let rows: Vec<(String,)> = sqlx::query_as(
                "SELECT user_id FROM group_members WHERE group_id = $1 AND user_id <> $2",
            )
            .bind(gid)
            .bind(&user.user_id)
            .fetch_all(&state.pool)
            .await?;
            rows.into_iter().map(|(u,)| u).collect()
        }
    };

    // Fan-out is atomic (M1): every recipient's mailbox row is inserted in ONE
    // transaction. If any insert fails (including the backlog cap tripping),
    // the whole commit rolls back — a partially-delivered commit would desync
    // the MLS group. Live pushes happen only after the commit succeeds.
    let mut tx = state.pool.begin().await?;
    let mut inserted: Vec<(String, Uuid, DateTime<Utc>)> = Vec::with_capacity(recipients.len());
    for r in &recipients {
        let (id, created_at) = insert_mailbox(
            &mut tx,
            &user.user_id,
            r,
            "commit",
            &body.group_id,
            &payload,
        )
        .await?;
        inserted.push((r.clone(), id, created_at));
    }
    tx.commit().await?;
    for (r, id, created_at) in &inserted {
        push_mailbox(
            &state,
            *id,
            *created_at,
            &user.user_id,
            r,
            "commit",
            &body.group_id,
            &payload,
        );
    }
    Ok(Json(json!({ "ok": true, "delivered": recipients.len() })))
}

/// (id, message_type, group_id, sender_id, payload, created_at)
type MailboxRow = (Uuid, String, String, String, Vec<u8>, DateTime<Utc>);

/// GET /api/mls/messages — my pending (unprocessed) mailbox, oldest first so
/// commits apply in order.
pub async fn pending_messages(
    State(state): State<AppState>,
    user: AuthUser,
) -> ApiResult<Json<Vec<Value>>> {
    let rows: Vec<MailboxRow> = sqlx::query_as(
        "SELECT id, message_type, group_id, sender_id, payload, created_at
         FROM mls_messages
         WHERE recipient_id = $1 AND NOT processed
         ORDER BY created_at, id",
    )
    .bind(&user.user_id)
    .fetch_all(&state.pool)
    .await?;
    let out = rows
        .into_iter()
        .map(
            |(id, message_type, group_id, sender_id, payload, created_at)| {
                json!({
                    "id": id,
                    "message_type": message_type,
                    "group_id": group_id,
                    "sender_id": sender_id,
                    "payload": BASE64.encode(payload),
                    "created_at": created_at.to_rfc3339(),
                })
            },
        )
        .collect();
    Ok(Json(out))
}

/// POST /api/mls/messages/{id}/ack — mark one of MY messages processed.
/// Someone else's message id is a 404 (no cross-user acks, no id oracle).
pub async fn ack_message(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let result =
        sqlx::query("UPDATE mls_messages SET processed = TRUE WHERE id = $1 AND recipient_id = $2")
            .bind(id)
            .bind(&user.user_id)
            .execute(&state.pool)
            .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}
