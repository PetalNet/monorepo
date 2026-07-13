//! Share lifecycle: requests, permanent (bidirectional) shares, temporary
//! (directional, expiring) shares. Task 727 deliberately returns a recorded
//! flag for direct handle resolution so the client cannot claim a request was
//! sent when no account exists; relationship state remains non-enumerable.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::{Extension, Json};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
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

/// A relationship lifecycle event always reaches both users. Keeping the
/// audience shape pure makes multi-device fan-out regression-testable without
/// coupling tests to the WebSocket or push transports.
fn both_party_audience<'a>(actor: &'a str, other: &'a str) -> [&'a str; 2] {
    [other, actor]
}

#[derive(Clone, Copy)]
pub(crate) enum TempTeardown {
    Removed,
    Expired,
}

impl TempTeardown {
    fn ws_type(self) -> &'static str {
        match self {
            Self::Removed => "share.temp_removed",
            Self::Expired => "share.temp_expired",
        }
    }
}

/// Fan out one temporary-share teardown without exposing relationship detail
/// to either user's push distributor. Frames are personalized so `user_id` is
/// always the peer whose relationship changed on that device.
pub(crate) fn notify_temp_teardown(
    state: &AppState,
    teardown: TempTeardown,
    id: Uuid,
    from_user_id: &str,
    to_user_id: &str,
) {
    let to_recipient = json!({
        "type": teardown.ws_type(),
        "id": id,
        "user_id": from_user_id,
    })
    .to_string();
    let to_actor = json!({
        "type": teardown.ws_type(),
        "id": id,
        "user_id": to_user_id,
    })
    .to_string();
    state.hub.send_to_user(to_user_id, &to_recipient);
    state.hub.send_to_user(from_user_id, &to_actor);

    // TempRevoked is the notification catalog's content-free teardown wake.
    // It is equally suitable for expiry: clients treat every wake as a prompt
    // to pull authoritative state, and UnifiedPush receives no event kind.
    for target in both_party_audience(from_user_id, to_user_id) {
        tokio::spawn(crate::push::wake_user_for_event(
            state.pool.clone(),
            target.to_owned(),
            crate::push::Event::TempRevoked,
            state.config.federation_allow_private,
        ));
    }
}

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

/// POST /api/shares/request — reports whether a handle resolved and was
/// recordable, while keeping pending/existing relationship states identical.
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

    if matches!(super::federation::domain_of(&to_user), Some(domain) if !domain.eq_ignore_ascii_case(&state.config.domain))
    {
        let identity_key = BASE64.encode(state.server_signing_key.verifying_key().as_bytes());
        super::federation::send_federated(
            &state,
            &user.user_id,
            &to_user,
            "share.request",
            json!({ "identity_key": identity_key }),
        )
        .await?;
        return Ok(Json(json!({ "ok": true, "recorded": true })));
    }

    let recorded = json!({ "ok": true, "recorded": true });

    // Task 727: syntactically valid but nonexistent handles must not produce a
    // false "Request sent" in the client. The explicit flag keeps the HTTP
    // shape stable while allowing the UI to report that resolution failed.
    if !user_exists(&state, &to_user).await? {
        return Ok(Json(json!({ "ok": true, "recorded": false })));
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
        return Ok(Json(json!({ "ok": true, "recorded": false })));
    }
    // Already sharing: idempotent generic 200, record nothing.
    if share_exists(&state, &user.user_id, &to_user).await? {
        return Ok(Json(recorded));
    }
    // A non-expired pending request in EITHER direction is already an open
    // ask. Older rows remain as lifecycle history but no longer block a retry.
    let pending: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM share_requests
         WHERE ((from_user_id = $1 AND to_user_id = $2)
             OR (from_user_id = $2 AND to_user_id = $1))
           AND status = 'pending'
           AND created_at >= now() - interval '30 days'
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
         DO UPDATE SET status = 'pending', created_at = now(), updated_at = now()
         WHERE share_requests.status <> 'pending'
            OR share_requests.created_at < now() - interval '30 days'",
    )
    .bind(&user.user_id)
    .bind(&to_user)
    .execute(&state.pool)
    .await?;

    // Tell every recipient device there's a request waiting. WS and push are
    // complementary: a live connection on one phone must not suppress
    // catch-up on another registered device.
    let notify = json!({ "type": "share.request", "from_user_id": user.user_id }).to_string();
    state.hub.send_to_user(&to_user, &notify);
    tokio::spawn(crate::push::wake_user_for_event(
        state.pool.clone(),
        to_user.clone(),
        crate::push::Event::ShareRequest,
        state.config.federation_allow_private,
    ));
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
           AND (u.is_federated OR sr.created_at >= now() - interval '30 days')
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
    pub expired: bool,
}

/// GET /api/shares/requests/outgoing — outgoing pending requests.
pub async fn outgoing_requests(
    State(state): State<AppState>,
    user: AuthUser,
) -> ApiResult<Json<Vec<OutgoingRequestRow>>> {
    let rows = sqlx::query_as::<_, OutgoingRequestRow>(
        "SELECT sr.id, sr.to_user_id, u.display_name AS to_display_name,
                sr.created_at,
                NOT u.is_federated
                    AND sr.created_at < now() - interval '30 days' AS expired
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
           AND (created_at >= now() - interval '30 days'
                OR EXISTS (
                    SELECT 1 FROM users
                    WHERE users.id = share_requests.from_user_id
                      AND users.is_federated
                ))
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
    // Both users' other devices must catch up too. User-visible copy is derived
    // from the authenticated state diff, never from this contentless wake.
    for target in [&from_user, &user.user_id] {
        tokio::spawn(crate::push::wake_user_for_event(
            state.pool.clone(),
            target.clone(),
            crate::push::Event::ShareAccepted,
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
    let requester: Option<(String,)> = sqlx::query_as(
        "SELECT from_user_id FROM share_requests
         WHERE id = $1 AND to_user_id = $2 AND status = 'pending'
           AND (created_at >= now() - interval '30 days'
                OR EXISTS (
                    SELECT 1 FROM users
                    WHERE users.id = share_requests.from_user_id
                      AND users.is_federated
                ))",
    )
    .bind(id)
    .bind(&user.user_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some((requester,)) = requester else {
        return Err(AppError::NotFound);
    };
    let remote = matches!(
        super::federation::domain_of(&requester),
        Some(domain) if !domain.eq_ignore_ascii_case(&state.config.domain)
    );
    if remote {
        // share.remove already has the signed federation semantics needed to
        // clear the peer's matching pending row and wake its client. With no
        // accepted share yet, it is precisely a terminal request event.
        super::federation::send_federated(
            &state,
            &user.user_id,
            &requester,
            "share.remove",
            json!({ "reason": "rejected", "request_id": id }),
        )
        .await?;
    }
    let result = sqlx::query(
        "UPDATE share_requests SET status = 'rejected', updated_at = now()
         WHERE id = $1 AND to_user_id = $2 AND status = 'pending'
        ",
    )
    .bind(id)
    .bind(&user.user_id)
    .execute(&state.pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }

    // Rejection is a lifecycle event, not a silent disappearance. Live
    // requester devices can clear their outgoing queue immediately; offline
    // reconciliation remains authoritative when the app next wakes.
    let notify = json!({
        "type": "share.rejected",
        "user_id": user.user_id,
        "request_id": id,
    })
    .to_string();
    if !remote {
        state.hub.send_to_user(&requester, &notify);
        // Older clients do not yet distinguish terminal request events, but
        // already treat share.request as an authoritative list nudge.
        let sync = json!({ "type": "share.request", "request_id": id }).to_string();
        state.hub.send_to_user(&requester, &sync);
        tokio::spawn(crate::push::wake_user_for_event(
            state.pool.clone(),
            requester,
            crate::push::Event::ShareRejected,
            state.config.federation_allow_private,
        ));
    }
    Ok(Json(json!({ "ok": true })))
}

/// DELETE /api/shares/requests/{id} — the requester withdraws a pending ask.
/// Not-yours and no-longer-pending requests share the same 404 response so a
/// caller cannot probe another user's request IDs.
pub async fn cancel_request(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let recipient: Option<(String,)> = sqlx::query_as(
        "SELECT to_user_id FROM share_requests
         WHERE id = $1 AND from_user_id = $2 AND status = 'pending'
        ",
    )
    .bind(id)
    .bind(&user.user_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some((recipient,)) = recipient else {
        return Err(AppError::NotFound);
    };
    let remote = matches!(
        super::federation::domain_of(&recipient),
        Some(domain) if !domain.eq_ignore_ascii_case(&state.config.domain)
    );
    if remote {
        super::federation::send_federated(
            &state,
            &user.user_id,
            &recipient,
            "share.remove",
            json!({ "reason": "cancelled", "request_id": id }),
        )
        .await?;
    }
    let result = sqlx::query(
        "DELETE FROM share_requests
         WHERE id = $1 AND from_user_id = $2 AND status = 'pending'",
    )
    .bind(id)
    .bind(&user.user_id)
    .execute(&state.pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }

    let notify = json!({
        "type": "share.cancelled",
        "user_id": user.user_id,
        "request_id": id,
    })
    .to_string();
    if !remote {
        state.hub.send_to_user(&recipient, &notify);
        let sync = json!({ "type": "share.request", "request_id": id }).to_string();
        state.hub.send_to_user(&recipient, &sync);
        tokio::spawn(crate::push::wake_user_for_event(
            state.pool.clone(),
            recipient,
            crate::push::Event::ShareCancelled,
            state.config.federation_allow_private,
        ));
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
    pub profile_version: DateTime<Utc>,
    pub since: DateTime<Utc>,
    /// When this peer's MLS identity last changed (task 726): the client
    /// rebuilds its pairwise group when this is newer than the group it holds.
    pub rekeyed_at: DateTime<Utc>,
}

/// GET /api/shares — my active permanent shares.
pub async fn list_shares(
    State(state): State<AppState>,
    user: AuthUser,
) -> ApiResult<Json<Vec<ShareRow>>> {
    let rows = sqlx::query_as::<_, ShareRow>(
        "SELECT CASE WHEN us.user_a = $1 THEN us.user_b ELSE us.user_a END AS user_id,
                u.display_name,
                u.updated_at AS profile_version,
                us.created_at AS since,
                u.rekeyed_at
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
    // Last-known snapshots belong to the relationship. Purge both directions
    // atomically so a later re-share cannot resurrect pre-revocation location.
    purge_directional_last_known(&mut tx, &user.user_id, &other).await?;
    purge_directional_last_known(&mut tx, &other, &user.user_id).await?;
    tx.commit().await?;

    if matches!(super::federation::domain_of(&other), Some(domain) if !domain.eq_ignore_ascii_case(&state.config.domain))
    {
        if let Err(error) = super::federation::send_federated(
            &state,
            &user.user_id,
            &other,
            "share.remove",
            json!({}),
        )
        .await
        {
            tracing::warn!(peer = %other, ?error, "federated share teardown delivery failed");
        }
    }

    // Live teardown (task 728): both parties' devices learn the share is gone
    // NOW — the removed peer drops the remover from People/Map at once and
    // stops encrypting fixes to them, instead of showing a stale "Dark since"
    // marker until some unrelated refresh. Best-effort (zero connections is
    // fine): a disconnected device receives the same contentless wake used by
    // other sharing changes, then refreshes GET /api/shares. The wake reveals
    // no peer or event detail to the distributor.
    let to_other = json!({ "type": "share.removed", "user_id": user.user_id }).to_string();
    let to_actor = json!({ "type": "share.removed", "user_id": other }).to_string();
    state.hub.send_to_user(&other, &to_other);
    state.hub.send_to_user(&user.user_id, &to_actor);
    // Unconditional because liveness is per user, while push endpoints are per
    // device: one connected phone must not suppress teardown on another phone.
    for target in [&other, &user.user_id] {
        tokio::spawn(crate::push::wake_user_for_event(
            state.pool.clone(),
            target.clone(),
            crate::push::Event::ShareRemoved,
            state.config.federation_allow_private,
        ));
    }

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
    state.hub.send_to_user(&user.user_id, &notify);
    // Wake both parties unconditionally: the recipient learns about the new
    // incoming share, while the actor's other devices add the outgoing target.
    for target in both_party_audience(&user.user_id, &to_user) {
        tokio::spawn(crate::push::wake_user_for_event(
            state.pool.clone(),
            target.to_owned(),
            crate::push::Event::TempCreated,
            state.config.federation_allow_private,
        ));
    }

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
    let mut tx = state.pool.begin().await?;
    let recipient: Option<(String,)> = sqlx::query_as(
        "DELETE FROM temporary_shares
         WHERE id = $1 AND from_user_id = $2 AND to_user_id IS NOT NULL
         RETURNING to_user_id",
    )
    .bind(id)
    .bind(&user.user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((recipient,)) = recipient else {
        return Err(AppError::NotFound);
    };
    purge_directional_last_known(&mut tx, &user.user_id, &recipient).await?;
    tx.commit().await?;

    notify_temp_teardown(&state, TempTeardown::Removed, id, &user.user_id, &recipient);
    // Compatibility nudge for catalog-v0 clients; they already refresh temp
    // state on this frame and will simply observe that the row disappeared.
    let sync = json!({ "type": "share.temp_created" }).to_string();
    state.hub.send_to_user(&recipient, &sync);
    state.hub.send_to_user(&user.user_id, &sync);
    Ok(Json(json!({ "ok": true })))
}

/// Remove the sender's user-addressed snapshot when a directional sharing
/// grant ends, preventing a later grant from resurrecting pre-revocation data.
pub(crate) async fn purge_directional_last_known(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    sender: &str,
    recipient: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "DELETE FROM location_updates lu
         USING entities e
         WHERE lu.sender_entity_id = e.id AND e.kind = 'person'
           AND e.owner_id = $1 AND lu.recipient_type = 'user'
           AND lu.recipient_id = $2
           AND NOT EXISTS (
               SELECT 1 FROM user_shares us
               WHERE (us.user_a = $1 AND us.user_b = $2)
                  OR (us.user_a = $2 AND us.user_b = $1))
           AND NOT EXISTS (
               SELECT 1 FROM temporary_shares ts
               WHERE ts.from_user_id = $1 AND ts.to_user_id = $2
                 AND ts.expires_at > now())",
    )
    .bind(sender)
    .bind(recipient)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[cfg(test)]
mod notification_event_tests {
    use super::{both_party_audience, TempTeardown};

    #[test]
    fn temporary_share_transitions_reach_actor_and_recipient_devices() {
        assert_eq!(both_party_audience("alice", "bob"), ["bob", "alice"],);
    }

    #[test]
    fn temporary_share_teardown_has_distinct_live_event_types() {
        assert_eq!(TempTeardown::Removed.ws_type(), "share.temp_removed");
        assert_eq!(TempTeardown::Expired.ws_type(), "share.temp_expired");
    }
}
