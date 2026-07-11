//! Registration + login (docs/legacy/server-map.md §1, behavior lifted).
//! Enumeration-safe: an existing username registers the same generic 400 as
//! any other failure, and unknown-user logins burn a dummy Argon2 verify so
//! timing doesn't reveal whether the account exists.

use std::sync::{Arc, LazyLock};

use axum::extract::State;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};

use crate::auth::{self, MAX_PASSWORD_BYTES, MIN_PASSWORD_BYTES};
use crate::db;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;

use super::rate_limit::{ClientIp, RateLimiter};

/// login + register: attempts per minute, per username and per client IP.
const AUTH_PER_MINUTE: u32 = 10;
/// register only: additional whole-server cap.
const REGISTER_GLOBAL_PER_MINUTE: u32 = 5;
/// login: whole-server cap on top of per-user/per-ip, so credential spraying
/// across many usernames from one (possibly "unknown") IP bucket is still
/// bounded. Generous — real users spread across their own per-user windows.
const LOGIN_GLOBAL_PER_MINUTE: u32 = 100;

/// Advisory-lock key serializing user creation, so two concurrent first
/// registrations can't both observe count==0 and both become admin.
pub(crate) const USER_CREATE_LOCK_KEY: i64 = 0x504F494E54; // "POINT"

#[derive(Deserialize)]
pub struct RegisterBody {
    pub username: String,
    pub password: String,
    pub display_name: Option<String>,
    pub invite_code: Option<String>,
    pub device_name: Option<String>,
}

#[derive(Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user_id: String,
    pub display_name: String,
    pub is_admin: bool,
}

pub async fn register(
    State(state): State<AppState>,
    Extension(limiter): Extension<Arc<RateLimiter>>,
    ClientIp(ip): ClientIp,
    Json(body): Json<RegisterBody>,
) -> ApiResult<Json<AuthResponse>> {
    // Limits first (keyed on the submitted name), so invalid attempts count.
    let username_key = body.username.trim().to_lowercase();
    limiter.check(&format!("register:ip:{ip}"), AUTH_PER_MINUTE)?;
    limiter.check(&format!("register:user:{username_key}"), AUTH_PER_MINUTE)?;
    limiter.check("register:global", REGISTER_GLOBAL_PER_MINUTE)?;

    let username = validate_username(&body.username)?;
    if body.password.len() < MIN_PASSWORD_BYTES || body.password.len() > MAX_PASSWORD_BYTES {
        return Err(AppError::BadRequest("password must be 8-128 bytes".into()));
    }
    let display_name = body
        .display_name
        .as_deref()
        .map(sanitize_display_name)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| username.clone());
    let device_name = body
        .device_name
        .as_deref()
        .map(sanitize_display_name)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "primary".to_string());
    let user_id = format!("{username}@{}", state.config.domain);

    // Hash before opening the transaction — Argon2 is deliberately slow.
    let password_hash = auth::hash_password(&body.password)?;

    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(USER_CREATE_LOCK_KEY)
        .execute(&mut *tx)
        .await?;
    let (user_count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users")
        .fetch_one(&mut *tx)
        .await?;
    let is_first_user = user_count == 0;

    // First user ever bootstraps the server: admin, no invite needed.
    if !is_first_user && !state.config.open_registration {
        let code = body
            .invite_code
            .as_deref()
            .map(|c| c.trim().to_uppercase())
            .filter(|c| !c.is_empty())
            .ok_or_else(|| AppError::BadRequest("invite required".into()))?;
        // Atomic claim: expired or exhausted codes match zero rows.
        let claimed: Option<(uuid::Uuid,)> = sqlx::query_as(
            "UPDATE invites SET uses = uses + 1
             WHERE code = $1
               AND uses < max_uses
               AND (expires_at IS NULL OR expires_at > now())
             RETURNING id",
        )
        .bind(&code)
        .fetch_optional(&mut *tx)
        .await?;
        if claimed.is_none() {
            return Err(AppError::BadRequest("invalid invite".into()));
        }
    }

    if let Err(e) = db::users::create_local_user(
        &mut tx,
        &user_id,
        &display_name,
        Some(&password_hash),
        is_first_user,
        &device_name,
        None,
    )
    .await
    {
        return Err(match AppError::from(e) {
            // Username taken -> same generic 400 as validation failures, so
            // registration can't be used to enumerate accounts.
            AppError::Conflict(_) => AppError::BadRequest("registration failed".into()),
            other => other,
        });
    }
    tx.commit().await?;

    let token = auth::create_token(&state.config.jwt_secret, &user_id, is_first_user)?;
    Ok(Json(AuthResponse {
        token,
        user_id,
        display_name,
        is_admin: is_first_user,
    }))
}

#[derive(Deserialize)]
pub struct LoginBody {
    /// Bare username or full `name@domain` id.
    pub username: String,
    pub password: String,
}

/// Verified on every login that can't reach a real hash (unknown user,
/// federated shadow, OIDC-only account) so those paths cost the same as a
/// wrong password against a real account.
static DUMMY_HASH: LazyLock<String> = LazyLock::new(|| {
    // Random per-process input: this hash exists only to burn the same Argon2
    // cost on can't-succeed logins; nothing ever verifies against it.
    let random: [u8; 16] = rand::random();
    auth::hash_password(&hex::encode(random)).expect("static dummy hash")
});

pub async fn login(
    State(state): State<AppState>,
    Extension(limiter): Extension<Arc<RateLimiter>>,
    ClientIp(ip): ClientIp,
    Json(body): Json<LoginBody>,
) -> ApiResult<Json<AuthResponse>> {
    let user_id = normalize_login_id(&body.username, &state.config.domain);
    limiter.check(&format!("login:ip:{ip}"), AUTH_PER_MINUTE)?;
    limiter.check(&format!("login:user:{user_id}"), AUTH_PER_MINUTE)?;
    limiter.check("login:global", LOGIN_GLOBAL_PER_MINUTE)?;

    let row: Option<(Option<String>, String, bool, bool)> = sqlx::query_as(
        "SELECT password_hash, display_name, is_admin, is_federated FROM users WHERE id = $1",
    )
    .bind(&user_id)
    .fetch_optional(&state.pool)
    .await?;

    // Only a local account with a stored hash may proceed; everything else
    // (unknown, federated shadow, OIDC-only NULL hash) fails identically.
    let (hash, display_name, is_admin) = match row {
        Some((Some(hash), display_name, is_admin, false)) => (hash, display_name, is_admin),
        _ => {
            let _ = auth::verify_password(&body.password, DUMMY_HASH.as_str());
            return Err(AppError::Unauthorized);
        }
    };
    if !auth::verify_password(&body.password, &hash) {
        return Err(AppError::Unauthorized);
    }

    let token = auth::create_token(&state.config.jwt_secret, &user_id, is_admin)?;
    Ok(Json(AuthResponse {
        token,
        user_id,
        display_name,
        is_admin,
    }))
}

fn normalize_login_id(raw: &str, domain: &str) -> String {
    let v = raw.trim().to_lowercase();
    if v.contains('@') {
        v
    } else {
        format!("{v}@{domain}")
    }
}

/// Username policy: 3-32 chars of `[a-z0-9_-]` after case-folding.
pub(crate) fn validate_username(raw: &str) -> Result<String, AppError> {
    let username = raw.trim().to_lowercase();
    let valid = (3..=32).contains(&username.len())
        && username
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-');
    if !valid {
        return Err(AppError::BadRequest(
            "username must be 3-32 characters: a-z, 0-9, _ or -".into(),
        ));
    }
    Ok(username)
}

/// Map an IdP-supplied name (preferred_username or sub) onto our username
/// policy: fold case, drop every disallowed char, cap at 32. Too little left
/// over is an error, never a guess.
pub(crate) fn map_oidc_username(raw: &str) -> Result<String, AppError> {
    let username: String = raw
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_' || *c == '-')
        .take(32)
        .collect();
    if username.len() < 3 {
        return Err(AppError::BadRequest(
            "cannot derive a valid username from the identity provider".into(),
        ));
    }
    Ok(username)
}

/// Strip HTML-significant chars, control chars, zero-width chars, and bidi
/// overrides (display names end up in client UI next to location data —
/// spoofing surface). Cap at 64 chars.
pub(crate) fn sanitize_display_name(raw: &str) -> String {
    raw.chars()
        .filter(|&c| {
            !matches!(c, '<' | '>' | '&')
                && !c.is_control()
                && !matches!(
                    c,
                    '\u{200B}'..='\u{200D}' | '\u{FEFF}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
                )
        })
        .take(64)
        .collect::<String>()
        .trim()
        .to_string()
}
