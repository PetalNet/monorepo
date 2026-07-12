//! Share lifecycle: requests, permanent (bidirectional) shares, temporary
//! (directional, expiring) shares. Enumeration-safe throughout: probing a user
//! id that doesn't exist gets the same response as one that does — the server
//! just records nothing (docs/legacy/server-map.md §7, DECISIONS D-005).

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::{Extension, Json};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;

use super::rate_limit::RateLimiter;

/// Share requests per minute, per calling user.
const SHARE_REQUESTS_PER_MINUTE: u32 = 30;

/// Temp shares: 1 minute .. 7 days.
const TEMP_SHARE_MAX_MINUTES: i64 = 10_080;

/// Precision is an opaque client-side hint (payloads are E2E-encrypted); the
/// server only keeps it from becoming a junk-storage channel: short lowercase
/// token, default `exact`.
pub(crate) fn validate_precision(raw: Option<&str>) -> Result<String, AppError> {
    let p = raw.unwrap_or("exact").trim().to_string();
    let valid = (1..=32).contains(&p.len())
        && p.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-');
    if !valid {
        return Err(AppError::BadRequest("invalid precision".into()));
    }
    Ok(p)
}

async fn user_exists(state: &AppState, user_id: &str) -> Result<bool, sqlx::Error> {
    let row: Option<(i32,)> = sqlx::query_as("SELECT 1 FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?;
    Ok(row.is_some())
}

async fn share_exists(state: &AppState, a: &str, b: &str) -> Result<bool, sqlx::Error> {
    let (lo, hi) = if a < b { (a, b) } else { (b, a) };
    let row: Option<(i32,)> =
        sqlx::query_as("SELECT 1 FROM user_shares WHERE user_a = $1 AND user_b = $2")
            .bind(lo)
            .bind(hi)
            .fetch_optional(&state.pool)
            .await?;
    Ok(row.is_some())
}

// ---------------------------------------------------------------------------
// share requests
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ShareRequestBody {
    pub to_user_id: String,
}

/// POST /api/shares/request — always the same generic 200 whether the target
/// exists, already has a pending request either way, or already shares with
/// the caller. Anything else would let a caller enumerate accounts or probe
/// relationship state.
///
/// Idempotency ladder (H2): an existing accepted share, or a *pending* request
/// in either direction, is a no-op 200. Otherwise the request is UPSERTed to
/// pending — re-opening a prior 'rejected'/'accepted' row — so that a share
/// that was unshared/rejected can always be requested again (the old bug was
/// treating ANY historical row as "already requested", making unshare/reject
/// irreversible).
pub async fn create_request(
    State(state): State<AppState>,
    Extension(limiter): Extension<Arc<RateLimiter>>,
    user: AuthUser,
    Json(body): Json<ShareRequestBody>,
) -> ApiResult<Json<Value>> {
    limiter.check(
        &format!("share_request:{}", user.user_id),
        SHARE_REQUESTS_PER_MINUTE,
    )?;

    let to_user = body.to_user_id.trim().to_lowercase();
    if to_user.is_empty() || to_user == user.user_id {
        // Self/empty targets carry no enumeration risk: honest 400.
        return Err(AppError::BadRequest("invalid target".into()));
    }

    let recorded = json!({ "ok": true });

    // Nonexistent target: pretend-success, record nothing.
    if !user_exists(&state, &to_user).await? {
        return Ok(Json(recorded));
    }
    // Target does not accept inbound asks: the same pretend-success, so the
    // setting itself cannot be probed (Wave B, who_can_add_me). Local
    // requests are same-server by construction, so only 'nobody' blocks here;
    // the federated inbox enforces 'same_server' too.
    let gate: Option<(String,)> = sqlx::query_as("SELECT who_can_add_me FROM users WHERE id = $1")
        .bind(&to_user)
        .fetch_optional(&state.pool)
        .await?;
    if matches!(gate, Some((ref v,)) if v == "nobody") {
        return Ok(Json(recorded));
    }
    // Already sharing: idempotent generic 200, record nothing.
    if share_exists(&state, &user.user_id, &to_user).await? {
        return Ok(Json(recorded));
    }
    // A pending request in EITHER direction is already an open ask: no-op 200.
    let pending: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM share_requests
         WHERE ((from_user_id = $1 AND to_user_id = $2)
             OR (from_user_id = $2 AND to_user_id = $1))
           AND status = 'pending'
         LIMIT 1",
    )
    .bind(&user.user_id)
    .bind(&to_user)
    .fetch_optional(&state.pool)
    .await?;
    if pending.is_some() {
        return Ok(Json(recorded));
    }
    // Otherwise open (or re-open) a pending request from caller to target. A
    // prior 'rejected'/'accepted' row on this exact pair is flipped back to
    // pending; a fresh pair inserts. ON CONFLICT keeps a concurrent duplicate
    // idempotent too.
    sqlx::query(
        "INSERT INTO share_requests (from_user_id, to_user_id) VALUES ($1, $2)
         ON CONFLICT (from_user_id, to_user_id)
         DO UPDATE SET status = 'pending', updated_at = now()
         WHERE share_requests.status <> 'pending'",
    )
    .bind(&user.user_id)
    .bind(&to_user)
    .execute(&state.pool)
    .await?;

    // Tell the recipient there's a request waiting. An online device refreshes
    // its pinned-requests list from the WS nudge; an offline one is woken by
    // push so it can pull the request (the wake carries no who/where).
    let notify = json!({ "type": "share.request", "from_user_id": user.user_id }).to_string();
    if state.hub.is_online(&to_user) {
        state.hub.send_to_user(&to_user, &notify);
    } else {
        tokio::spawn(crate::push::wake_user(
            state.pool.clone(),
            to_user.clone(),
            crate::push::Wake::new("share_request"),
            state.config.federation_allow_private,
        ));
    }
    Ok(Json(recorded))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct IncomingRequestRow {
    pub id: Uuid,
    pub from_user_id: String,
    pub from_display_name: String,
    pub created_at: DateTime<Utc>,
}

/// GET /api/shares/requests — incoming pending requests.
pub async fn incoming_requests(
    State(state): State<AppState>,
    user: AuthUser,
) -> ApiResult<Json<Vec<IncomingRequestRow>>> {
    let rows = sqlx::query_as::<_, IncomingRequestRow>(
        "SELECT sr.id, sr.from_user_id, u.display_name AS from_display_name, sr.created_at
         FROM share_requests sr
         JOIN users u ON u.id = sr.from_user_id
         WHERE sr.to_user_id = $1 AND sr.status = 'pending'
         ORDER BY sr.created_at DESC",
    )
    .bind(&user.user_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct OutgoingRequestRow {
    pub id: Uuid,
    pub to_user_id: String,
    pub to_display_name: String,
    pub created_at: DateTime<Utc>,
}

/// GET /api/shares/requests/outgoing — outgoing pending requests.
pub async fn outgoing_requests(
    State(state): State<AppState>,
    user: AuthUser,
) -> ApiResult<Json<Vec<OutgoingRequestRow>>> {
    let rows = sqlx::query_as::<_, OutgoingRequestRow>(
        "SELECT sr.id, sr.to_user_id, u.display_name AS to_display_name, sr.created_at
         FROM share_requests sr
         JOIN users u ON u.id = sr.to_user_id
         WHERE sr.from_user_id = $1 AND sr.status = 'pending'
         ORDER BY sr.created_at DESC",
    )
    .bind(&user.user_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

/// POST /api/shares/requests/{id}/accept — only the addressee. Not-yours and
/// nonexistent are the same 404 (no probing which request ids exist).
pub async fn accept_request(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let mut tx = state.pool.begin().await?;
    let row: Option<(String,)> = sqlx::query_as(
        "UPDATE share_requests SET status = 'accepted', updated_at = now()
         WHERE id = $1 AND to_user_id = $2 AND status = 'pending'
         RETURNING from_user_id",
    )
    .bind(id)
    .bind(&user.user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((from_user,)) = row else {
        return Err(AppError::NotFound);
    };
    let (lo, hi) = if from_user < user.user_id {
        (&from_user, &user.user_id)
    } else {
        (&user.user_id, &from_user)
    };
    sqlx::query("INSERT INTO user_shares (user_a, user_b) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(lo)
        .bind(hi)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    // Best-effort live notify to every device of both parties (zero
    // connections is fine): each side learns who they now share with.
    let to_requester = json!({ "type": "share.accepted", "user_id": user.user_id }).to_string();
    let to_accepter = json!({ "type": "share.accepted", "user_id": from_user }).to_string();
    state.hub.send_to_user(&from_user, &to_requester);
    state.hub.send_to_user(&user.user_id, &to_accepter);
    // The requester (the one who's been waiting) gets a push if they're not
    // online to hear the WS notify. "someone accepted and started sharing" is
    // in the v1 notification set.
    if !state.hub.is_online(&from_user) {
        tokio::spawn(crate::push::wake_user(
            state.pool.clone(),
            from_user.clone(),
            crate::push::Wake::new("share_accepted"),
            state.config.federation_allow_private,
        ));
    }

    Ok(Json(json!({ "ok": true, "user_id": from_user })))
}

/// POST /api/shares/requests/{id}/reject — only the addressee.
pub async fn reject_request(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let result = sqlx::query(
        "UPDATE share_requests SET status = 'rejected', updated_at = now()
         WHERE id = $1 AND to_user_id = $2 AND status = 'pending'",
    )
    .bind(id)
    .bind(&user.user_id)
    .execute(&state.pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// permanent shares
// ---------------------------------------------------------------------------

#[derive(Serialize, sqlx::FromRow)]
pub struct ShareRow {
    pub user_id: String,
    pub display_name: String,
    pub since: DateTime<Utc>,
}

/// GET /api/shares — my active permanent shares.
pub async fn list_shares(
    State(state): State<AppState>,
    user: AuthUser,
) -> ApiResult<Json<Vec<ShareRow>>> {
    let rows = sqlx::query_as::<_, ShareRow>(
        "SELECT CASE WHEN us.user_a = $1 THEN us.user_b ELSE us.user_a END AS user_id,
                u.display_name,
                us.created_at AS since
         FROM user_shares us
         JOIN users u ON u.id = CASE WHEN us.user_a = $1 THEN us.user_b ELSE us.user_a END
         WHERE us.user_a = $1 OR us.user_b = $1
         ORDER BY us.created_at DESC",
    )
    .bind(&user.user_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

/// DELETE /api/shares/{user_id} — either party may sever the share. The caller
/// is one side by construction, so the row lookup is the whole authz check.
pub async fn delete_share(
    State(state): State<AppState>,
    user: AuthUser,
    Path(other): Path<String>,
) -> ApiResult<Json<Value>> {
    let (lo, hi) = if user.user_id < other {
        (&user.user_id, &other)
    } else {
        (&other, &user.user_id)
    };
    let mut tx = state.pool.begin().await?;
    let result = sqlx::query("DELETE FROM user_shares WHERE user_a = $1 AND user_b = $2")
        .bind(lo)
        .bind(hi)
        .execute(&mut *tx)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    // Clear any share_requests rows (either direction, any status) between the
    // pair so a future request starts from a clean slate rather than tripping
    // over a stale 'accepted'/'rejected' row (H2).
    sqlx::query(
        "DELETE FROM share_requests
         WHERE (from_user_id = $1 AND to_user_id = $2)
            OR (from_user_id = $2 AND to_user_id = $1)",
    )
    .bind(&user.user_id)
    .bind(&other)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// temporary shares
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct TempShareBody {
    pub to_user_id: String,
    pub duration_minutes: i64,
    pub precision: Option<String>,
}

/// POST /api/shares/temp — directional, expiring share. Same enumeration-safe
/// posture as share requests: a nonexistent target gets a response of the
/// exact same shape (fresh id, computed expiry) and nothing is recorded.
pub async fn create_temp(
    State(state): State<AppState>,
    Extension(limiter): Extension<Arc<RateLimiter>>,
    user: AuthUser,
    Json(body): Json<TempShareBody>,
) -> ApiResult<Json<Value>> {
    // Same per-user budget as share requests: a temp share is another way to
    // initiate a relationship, so it must be throttled to bound enumeration
    // and spam (L4). Shared key so the two paths can't be summed to bypass it.
    limiter.check(
        &format!("share_request:{}", user.user_id),
        SHARE_REQUESTS_PER_MINUTE,
    )?;

    let to_user = body.to_user_id.trim().to_lowercase();
    if to_user.is_empty() || to_user == user.user_id {
        return Err(AppError::BadRequest("invalid target".into()));
    }
    if !(1..=TEMP_SHARE_MAX_MINUTES).contains(&body.duration_minutes) {
        return Err(AppError::BadRequest(
            "duration_minutes must be 1-10080".into(),
        ));
    }
    let precision = validate_precision(body.precision.as_deref())?;
    let expires_at = Utc::now() + Duration::minutes(body.duration_minutes);

    if !user_exists(&state, &to_user).await? {
        // Pretend-success: same shape, nothing stored, nobody notified.
        return Ok(Json(json!({
            "id": Uuid::new_v4(),
            "to_user_id": to_user,
            "precision": precision,
            "expires_at": expires_at,
        })));
    }

    let (id,): (Uuid,) = sqlx::query_as(
        "INSERT INTO temporary_shares (from_user_id, to_user_id, precision, expires_at)
         VALUES ($1, $2, $3, $4)
         RETURNING id",
    )
    .bind(&user.user_id)
    .bind(&to_user)
    .bind(&precision)
    .bind(expires_at)
    .fetch_one(&state.pool)
    .await?;

    let notify = json!({
        "type": "share.temp_created",
        "id": id,
        "from_user_id": user.user_id,
        "precision": precision,
        "expires_at": expires_at,
    })
    .to_string();
    state.hub.send_to_user(&to_user, &notify);

    Ok(Json(json!({
        "id": id,
        "to_user_id": to_user,
        "precision": precision,
        "expires_at": expires_at,
    })))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct TempShareRow {
    pub id: Uuid,
    pub from_user_id: String,
    pub to_user_id: String,
    pub precision: String,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

/// GET /api/shares/temp — my active (unexpired) temp shares, both directions.
/// Link-token shares (no to_user) are v1.5; user-addressed rows always have a
/// to_user, hence the NOT NULL filter.
pub async fn list_temp(
    State(state): State<AppState>,
    user: AuthUser,
) -> ApiResult<Json<Vec<TempShareRow>>> {
    let rows = sqlx::query_as::<_, TempShareRow>(
        "SELECT id, from_user_id, to_user_id, precision, expires_at, created_at
         FROM temporary_shares
         WHERE (from_user_id = $1 OR to_user_id = $1)
           AND to_user_id IS NOT NULL
           AND expires_at > now()
         ORDER BY expires_at ASC",
    )
    .bind(&user.user_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

/// DELETE /api/shares/temp/{id} — only the sharer may revoke; anyone else
/// (including the recipient) gets the same 404 as a nonexistent id.
pub async fn delete_temp(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let result = sqlx::query("DELETE FROM temporary_shares WHERE id = $1 AND from_user_id = $2")
        .bind(id)
        .bind(&user.user_id)
        .execute(&state.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}
