//! Authenticated self-service: profile, password change, account deletion,
//! FCM token registration.

use axum::extract::State;
use axum::Extension;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::{self, AuthUser, MAX_PASSWORD_BYTES, MIN_PASSWORD_BYTES};
use crate::error::{ApiResult, AppError};
use crate::state::AppState;

pub async fn me(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    let row: Option<(String, bool, bool, String, String, bool)> = sqlx::query_as(
        "SELECT display_name, is_admin, ghost_active, visibility_mode,
                who_can_add_me, avatar IS NOT NULL
         FROM users WHERE id = $1",
    )
    .bind(&user.user_id)
    .fetch_optional(&state.pool)
    .await?;
    // AuthUser just proved the row exists; a miss here is a mid-request delete.
    let Some((display_name, is_admin, ghost_active, visibility_mode, who_can_add_me, has_avatar)) =
        row
    else {
        return Err(AppError::Unauthorized);
    };
    Ok(Json(json!({
        "user_id": user.user_id,
        "display_name": display_name,
        "is_admin": is_admin,
        "ghost_active": ghost_active,
        "visibility_mode": visibility_mode,
        "who_can_add_me": who_can_add_me,
        "has_avatar": has_avatar,
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
    // Tear down any live WS the deleted account still holds: the token check
    // only runs at connect, so an already-open socket would otherwise survive
    // deletion (M11 / D-011 parity).
    state.hub.close_user(&user.user_id);
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

    // Close every live WS for this user: their old-token sockets are now
    // revoked (password_changed_at moved forward) and the token check only runs
    // at connect, so an open socket would otherwise linger (M11 / D-011). The
    // caller reconnects with the fresh token below.
    state.hub.close_user(&user.user_id);

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

// ---------------------------------------------------------------------------
// Profile + privacy (Wave B: the Me tab)
// ---------------------------------------------------------------------------

/// Display-name changes per minute (cheap, but no reason to allow spam).
const PROFILE_UPDATES_PER_MINUTE: u32 = 12;
/// Avatar uploads per minute (each is up to 128 KiB of DB write).
const AVATAR_UPLOADS_PER_MINUTE: u32 = 6;
/// Hard cap on the stored avatar bytes ("photo-dot": a small square).
const MAX_AVATAR_BYTES: usize = 128 * 1024;

#[derive(Deserialize)]
pub struct UpdateProfileBody {
    pub display_name: String,
}

/// PUT /api/account/profile — change the caller's display name (sanitized the
/// same way registration is).
pub async fn update_profile(
    State(state): State<AppState>,
    Extension(limiter): Extension<std::sync::Arc<super::rate_limit::RateLimiter>>,
    user: AuthUser,
    Json(body): Json<UpdateProfileBody>,
) -> ApiResult<Json<Value>> {
    limiter.check(
        &format!("profile:{}", user.user_id),
        PROFILE_UPDATES_PER_MINUTE,
    )?;
    let name = super::auth::sanitize_display_name(&body.display_name);
    if name.is_empty() {
        return Err(AppError::BadRequest("display name is empty".into()));
    }
    sqlx::query("UPDATE users SET display_name = $1, updated_at = now() WHERE id = $2")
        .bind(&name)
        .bind(&user.user_id)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "ok": true, "display_name": name })))
}

#[derive(Deserialize)]
pub struct UpdatePrivacyBody {
    pub who_can_add_me: String,
}

/// PUT /api/account/privacy — who may open a share request to me. Enforced
/// silently at request creation (anti-enumeration: a blocked ask looks like
/// any other generic ok).
pub async fn update_privacy(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<UpdatePrivacyBody>,
) -> ApiResult<Json<Value>> {
    let value = body.who_can_add_me.as_str();
    if !matches!(value, "anyone" | "same_server" | "nobody") {
        return Err(AppError::BadRequest(
            "who_can_add_me must be anyone, same_server, or nobody".into(),
        ));
    }
    sqlx::query("UPDATE users SET who_can_add_me = $1, updated_at = now() WHERE id = $2")
        .bind(value)
        .bind(&user.user_id)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "ok": true, "who_can_add_me": value })))
}

#[derive(Deserialize)]
pub struct AvatarBody {
    /// Base64 image bytes (jpeg/png/webp, <=128 KiB decoded).
    pub data: String,
    pub mime: String,
}

/// Magic-byte check: the bytes must actually be the format the mime claims,
/// so the avatar endpoint can never serve attacker-typed content.
fn avatar_bytes_match_mime(bytes: &[u8], mime: &str) -> bool {
    match mime {
        "image/jpeg" => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
        "image/png" => bytes.starts_with(&[0x89, b'P', b'N', b'G']),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

/// POST /api/account/avatar — set the caller's photo-dot.
pub async fn upload_avatar(
    State(state): State<AppState>,
    Extension(limiter): Extension<std::sync::Arc<super::rate_limit::RateLimiter>>,
    user: AuthUser,
    Json(body): Json<AvatarBody>,
) -> ApiResult<Json<Value>> {
    limiter.check(
        &format!("avatar:{}", user.user_id),
        AVATAR_UPLOADS_PER_MINUTE,
    )?;
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&body.data)
        .map_err(|_| AppError::BadRequest("avatar: invalid base64".into()))?;
    if bytes.is_empty() || bytes.len() > MAX_AVATAR_BYTES {
        return Err(AppError::BadRequest(
            "avatar: must be 1 byte to 128 KiB".into(),
        ));
    }
    if !avatar_bytes_match_mime(&bytes, &body.mime) {
        return Err(AppError::BadRequest(
            "avatar: mime must be image/jpeg, image/png, or image/webp and match the bytes".into(),
        ));
    }
    sqlx::query("UPDATE users SET avatar = $1, avatar_mime = $2, updated_at = now() WHERE id = $3")
        .bind(&bytes)
        .bind(&body.mime)
        .bind(&user.user_id)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

/// DELETE /api/account/avatar — back to the monogram.
pub async fn delete_avatar(
    State(state): State<AppState>,
    user: AuthUser,
) -> ApiResult<Json<Value>> {
    sqlx::query(
        "UPDATE users SET avatar = NULL, avatar_mime = NULL, updated_at = now() WHERE id = $1",
    )
    .bind(&user.user_id)
    .execute(&state.pool)
    .await?;
    Ok(Json(json!({ "ok": true })))
}

/// GET /api/users/{user_id}/avatar — a person's photo-dot, only for accounts
/// with a live relationship to them (authz::can_view_profile): self, an
/// accepted or temp share, a shared group, or a pending request in either
/// direction (you see who is asking before you answer). 404 otherwise — the
/// same as "no avatar", so the gate leaks nothing.
pub async fn get_user_avatar(
    State(state): State<AppState>,
    user: AuthUser,
    axum::extract::Path(target): axum::extract::Path<String>,
) -> ApiResult<axum::response::Response> {
    use axum::response::IntoResponse;
    let target = target.trim().to_lowercase();
    if !crate::authz::can_view_profile(&state.pool, &user.user_id, &target).await? {
        return Err(AppError::NotFound);
    }
    let row: Option<(Option<Vec<u8>>, Option<String>)> =
        sqlx::query_as("SELECT avatar, avatar_mime FROM users WHERE id = $1")
            .bind(&target)
            .fetch_optional(&state.pool)
            .await?;
    let Some((Some(bytes), Some(mime))) = row else {
        return Err(AppError::NotFound);
    };
    Ok((
        [
            (axum::http::header::CONTENT_TYPE, mime),
            (
                axum::http::header::CACHE_CONTROL,
                "private, max-age=300".to_string(),
            ),
        ],
        bytes,
    )
        .into_response())
}
