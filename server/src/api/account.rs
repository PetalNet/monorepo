//! Authenticated self-service: profile, password change, account deletion,
//! FCM token registration.

use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::{self, AuthUser, MAX_PASSWORD_BYTES, MIN_PASSWORD_BYTES};
use crate::error::{ApiResult, AppError};
use crate::state::AppState;

pub async fn me(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    let row: Option<(String, bool, bool, String)> = sqlx::query_as(
        "SELECT display_name, is_admin, ghost_active, visibility_mode FROM users WHERE id = $1",
    )
    .bind(&user.user_id)
    .fetch_optional(&state.pool)
    .await?;
    // AuthUser just proved the row exists; a miss here is a mid-request delete.
    let Some((display_name, is_admin, ghost_active, visibility_mode)) = row else {
        return Err(AppError::Unauthorized);
    };
    Ok(Json(json!({
        "user_id": user.user_id,
        "display_name": display_name,
        "is_admin": is_admin,
        "ghost_active": ghost_active,
        "visibility_mode": visibility_mode,
    })))
}

#[derive(Deserialize)]
pub struct DeleteAccountBody {
    pub password: String,
}

pub async fn delete_account(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<DeleteAccountBody>,
) -> ApiResult<Json<Value>> {
    verify_current_password(&state, &user.user_id, &body.password).await?;
    // Everything the user owns cascades from the users row (schema FKs).
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(&user.user_id)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct ChangePasswordBody {
    pub current_password: String,
    pub new_password: String,
}

pub async fn change_password(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<ChangePasswordBody>,
) -> ApiResult<Json<Value>> {
    if body.new_password.len() < MIN_PASSWORD_BYTES || body.new_password.len() > MAX_PASSWORD_BYTES
    {
        return Err(AppError::BadRequest("password must be 8-128 bytes".into()));
    }
    verify_current_password(&state, &user.user_id, &body.current_password).await?;

    let new_hash = auth::hash_password(&body.new_password)?;
    // password_changed_at is the revocation floor: every token issued before
    // this instant is dead (auth::validate_token).
    sqlx::query(
        "UPDATE users SET password_hash = $1, password_changed_at = now(), updated_at = now()
         WHERE id = $2",
    )
    .bind(&new_hash)
    .bind(&user.user_id)
    .execute(&state.pool)
    .await?;

    // Fresh token so the caller's own session survives the revocation.
    let token = auth::create_token(&state.config.jwt_secret, &user.user_id, user.is_admin)?;
    Ok(Json(json!({ "ok": true, "token": token })))
}

#[derive(Deserialize)]
pub struct FcmTokenBody {
    pub token: String,
}

pub async fn register_fcm_token(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<FcmTokenBody>,
) -> ApiResult<Json<Value>> {
    let token = body.token.trim();
    if token.is_empty() || token.len() > 4096 {
        return Err(AppError::BadRequest("invalid token".into()));
    }
    sqlx::query(
        "INSERT INTO fcm_tokens (user_id, token) VALUES ($1, $2)
         ON CONFLICT (user_id, token) DO UPDATE SET updated_at = now()",
    )
    .bind(&user.user_id)
    .bind(token)
    .execute(&state.pool)
    .await?;
    Ok(Json(json!({ "ok": true })))
}

/// Password confirmation gate for destructive account operations. OIDC-only
/// accounts (NULL hash) have no password to confirm with: fail closed.
async fn verify_current_password(state: &AppState, user_id: &str, password: &str) -> ApiResult<()> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT password_hash FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(&state.pool)
            .await?;
    let Some((Some(hash),)) = row else {
        return Err(AppError::Unauthorized);
    };
    if !auth::verify_password(password, &hash) {
        return Err(AppError::Unauthorized);
    }
    Ok(())
}
