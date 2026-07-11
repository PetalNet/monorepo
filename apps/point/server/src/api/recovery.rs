//! Zero-knowledge recovery backup (M4). The client encrypts its exported MLS
//! state under a key derived from a user-held recovery code (see
//! `point_core::recovery`) and stores the resulting opaque blob here. The server
//! only ever holds ciphertext keyed by the owning user — it cannot derive the
//! key or read the state. A new device fetches the blob and, given the recovery
//! code, restores the identity locally.
//!
//! Every endpoint is scoped to the authenticated user: you can only read, write,
//! or delete YOUR OWN backup.

use axum::extract::State;
use axum::Json;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;

/// Recovery blobs are a small encrypted state export; 512 KiB decoded is already
/// far more than a real backup needs and caps abuse of per-user storage.
const MAX_BACKUP_BYTES: usize = 512 * 1024;

#[derive(Deserialize)]
pub struct PutBackupBody {
    /// Base64 of the client-produced opaque recovery blob.
    pub blob: String,
}

/// PUT /api/recovery/backup — store (or replace) the caller's encrypted backup.
pub async fn put_backup(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<PutBackupBody>,
) -> ApiResult<Json<Value>> {
    let blob = BASE64
        .decode(body.blob.trim())
        .map_err(|_| AppError::BadRequest("blob is not valid base64".into()))?;
    if blob.is_empty() {
        return Err(AppError::BadRequest("blob is empty".into()));
    }
    if blob.len() > MAX_BACKUP_BYTES {
        return Err(AppError::BadRequest("backup too large".into()));
    }

    let row: Option<(DateTime<Utc>,)> = sqlx::query_as(
        "INSERT INTO mls_backups (user_id, blob, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (user_id) DO UPDATE SET blob = EXCLUDED.blob, updated_at = now()
         RETURNING updated_at",
    )
    .bind(&user.user_id)
    .bind(&blob)
    .fetch_optional(&state.pool)
    .await?;

    // No row back only if the user row vanished mid-request (FK) — treat as auth
    // loss rather than pretend success.
    let Some((updated_at,)) = row else {
        return Err(AppError::Unauthorized);
    };
    Ok(Json(json!({ "ok": true, "updated_at": updated_at })))
}

/// GET /api/recovery/backup — fetch the caller's encrypted backup, or 404 if
/// they have never stored one.
pub async fn get_backup(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    let row: Option<(Vec<u8>, DateTime<Utc>)> =
        sqlx::query_as("SELECT blob, updated_at FROM mls_backups WHERE user_id = $1")
            .bind(&user.user_id)
            .fetch_optional(&state.pool)
            .await?;
    let Some((blob, updated_at)) = row else {
        return Err(AppError::NotFound);
    };
    Ok(Json(json!({
        "blob": BASE64.encode(&blob),
        "updated_at": updated_at,
    })))
}

/// DELETE /api/recovery/backup — remove the caller's backup (e.g. on account
/// hardening or recovery-code rotation before re-uploading).
pub async fn delete_backup(
    State(state): State<AppState>,
    user: AuthUser,
) -> ApiResult<Json<Value>> {
    sqlx::query("DELETE FROM mls_backups WHERE user_id = $1")
        .bind(&user.user_id)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "ok": true })))
}
