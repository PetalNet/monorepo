//! Encrypted location history (ciphertext relay only — blobs are opaque MLS
//! payloads). Reads go through the authz gate (D-005): no relationship, no
//! rows. We answer 404, not 403, when `can_view` denies — a 403 would confirm
//! the target account exists; 404 is indistinguishable from "no such user".

use axum::extract::{Path, Query, State};
use axum::Json;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::authz;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;

const DEFAULT_LIMIT: i64 = 200;
const MAX_LIMIT: i64 = 1000;

#[derive(Deserialize)]
pub struct HistoryQuery {
    /// Epoch millis; only rows with a strictly later client_timestamp are
    /// returned. A client walks a large window forward by repeatedly advancing
    /// `since` to the max client_timestamp it has seen.
    pub since: Option<i64>,
    pub limit: Option<i64>,
}

/// GET /api/history/{user_id}?since=&limit= — the target's person-entity
/// history, restricted to rows encrypted FOR an audience the viewer belongs
/// to: their own user-addressed rows, or group-addressed rows in groups the
/// viewer shares with a broadcasting target. Your own history is unrestricted.
pub async fn get_history(
    State(state): State<AppState>,
    user: AuthUser,
    Path(target): Path<String>,
    Query(q): Query<HistoryQuery>,
) -> ApiResult<Json<Vec<Value>>> {
    let target = target.trim().to_lowercase();
    let since = q.since.unwrap_or(0);
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

    // Fail-closed gate; unknown targets come back "not viewable" -> same 404.
    if !authz::can_view(&state.pool, &user.user_id, &target).await? {
        return Err(AppError::NotFound);
    }

    let own = user.user_id == target;
    // First sync (since==0) returns the newest rows (DESC) so a client sees its
    // most recent locations immediately. A paging client that passes since>0
    // gets the OLDEST rows above the cursor (ASC), so repeatedly advancing
    // `since` to the last-seen timestamp walks forward through the whole window
    // without ever skipping the middle (M8). The order token is a fixed literal,
    // never user input.
    let order = if since > 0 { "ASC" } else { "DESC" };
    let sql = format!(
        "SELECT lh.encrypted_blob, lh.client_timestamp, lh.recipient_type, lh.recipient_id
         FROM location_history lh
         JOIN entities e ON e.id = lh.entity_id
         WHERE e.owner_id = $1 AND e.kind = 'person'
           AND lh.client_timestamp > $2
           AND ($3
                OR (lh.recipient_type = 'user' AND lh.recipient_id = $4)
                OR (lh.recipient_type = 'group' AND lh.recipient_id IN (
                        SELECT gv.group_id::text
                        FROM group_members gv
                        JOIN group_members gt ON gt.group_id = gv.group_id
                        WHERE gv.user_id = $4 AND gt.user_id = $1 AND gt.sharing)))
         ORDER BY lh.client_timestamp {order}
         LIMIT $5"
    );
    let rows: Vec<(Vec<u8>, i64, String, String)> = sqlx::query_as(&sql)
        .bind(&target)
        .bind(since)
        .bind(own)
        .bind(&user.user_id)
        .bind(limit)
        .fetch_all(&state.pool)
        .await?;

    let out = rows
        .into_iter()
        .map(|(blob, ts, rtype, rid)| {
            json!({
                "encrypted_blob": BASE64.encode(blob),
                "client_timestamp": ts,
                "recipient_type": rtype,
                "recipient_id": rid,
            })
        })
        .collect();
    Ok(Json(out))
}

/// GET /api/current/{user_id} — current, non-expired encrypted fixes for the
/// target, scoped to audiences the viewer is authorized to consume. This is
/// the reconnect snapshot counterpart to best-effort `location.broadcast`.
pub async fn get_current(
    State(state): State<AppState>,
    user: AuthUser,
    Path(target): Path<String>,
) -> ApiResult<Json<Vec<Value>>> {
    let target = target.trim().to_lowercase();
    if !authz::can_view(&state.pool, &user.user_id, &target).await? {
        return Err(AppError::NotFound);
    }

    let own = user.user_id == target;
    let rows: Vec<(Vec<u8>, i64, String, String)> = sqlx::query_as(
        "SELECT lu.encrypted_blob, lu.client_timestamp,
                lu.recipient_type, lu.recipient_id
         FROM location_updates lu
         JOIN entities e ON e.id = lu.sender_entity_id
         WHERE e.owner_id = $1 AND e.kind = 'person'
           AND lu.created_at + make_interval(secs => lu.ttl_seconds) > now()
           AND ($2
                OR (lu.recipient_type = 'user' AND lu.recipient_id = $3)
                OR (lu.recipient_type = 'group' AND lu.recipient_id IN (
                        SELECT gv.group_id::text
                        FROM group_members gv
                        JOIN group_members gt ON gt.group_id = gv.group_id
                        WHERE gv.user_id = $3 AND gt.user_id = $1 AND gt.sharing)))
         ORDER BY lu.client_timestamp",
    )
    .bind(&target)
    .bind(own)
    .bind(&user.user_id)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(
        rows.into_iter()
            .map(|(blob, ts, rtype, rid)| {
                json!({
                    "encrypted_blob": BASE64.encode(blob),
                    "client_timestamp": ts,
                    "recipient_type": rtype,
                    "recipient_id": rid,
                })
            })
            .collect(),
    ))
}

/// DELETE /api/history — wipe my own person-entity history rows.
pub async fn delete_my_history(
    State(state): State<AppState>,
    user: AuthUser,
) -> ApiResult<Json<Value>> {
    let result = sqlx::query(
        "DELETE FROM location_history lh
         USING entities e
         WHERE lh.entity_id = e.id AND e.owner_id = $1 AND e.kind = 'person'",
    )
    .bind(&user.user_id)
    .execute(&state.pool)
    .await?;
    Ok(Json(
        json!({ "ok": true, "deleted": result.rows_affected() }),
    ))
}
