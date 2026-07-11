//! Authentication primitives: Argon2id password hashing (params pinned, D-006),
//! HS256 JWTs (algorithm pinned both ways), and the `AuthUser` extractor that
//! enforces `password_changed_at` revocation on every authenticated request.
//! The same `validate_token` runs on REST and on the WS first-message auth
//! (D-011) — there is exactly one way a token becomes a user.

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use chrono::{DateTime, Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::state::AppState;

/// Pinned Argon2id v19, m=19456 KiB, t=2, p=1 (OWASP baseline). Pinned so a
/// crate upgrade can never silently change the KDF cost.
fn argon2() -> Argon2<'static> {
    let params = Params::new(19_456, 2, 1, None).expect("valid pinned Argon2 params");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

/// Reject absurd password lengths before hashing (Argon2 DoS guard).
pub const MAX_PASSWORD_BYTES: usize = 128;
pub const MIN_PASSWORD_BYTES: usize = 8;

pub fn hash_password(password: &str) -> Result<String, AppError> {
    if password.len() > MAX_PASSWORD_BYTES {
        return Err(AppError::BadRequest("password too long".into()));
    }
    let salt = SaltString::generate(&mut OsRng);
    argon2()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| AppError::Internal(format!("password hash: {e}")))
}

pub fn verify_password(password: &str, phc_hash: &str) -> bool {
    if password.len() > MAX_PASSWORD_BYTES {
        return false;
    }
    let Ok(parsed) = PasswordHash::new(phc_hash) else {
        return false;
    };
    // Verify with default-config Argon2: the PHC string carries its own params,
    // so previously-hashed passwords keep working if we ever re-pin.
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

pub const TOKEN_LIFETIME_DAYS: i64 = 7;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    /// Full user id, `name@domain`.
    pub sub: String,
    pub is_admin: bool,
    pub exp: i64,
    pub iat: i64,
}

pub fn create_token(secret: &str, user_id: &str, is_admin: bool) -> Result<String, AppError> {
    let now = Utc::now();
    let claims = Claims {
        sub: user_id.to_string(),
        is_admin,
        exp: (now + Duration::days(TOKEN_LIFETIME_DAYS)).timestamp(),
        iat: now.timestamp(),
    };
    encode(
        &Header::new(jsonwebtoken::Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(format!("token encode: {e}")))
}

/// Signature/expiry verification only. Callers almost always want
/// [`validate_token`], which also enforces revocation.
pub fn verify_token(secret: &str, token: &str) -> Result<Claims, AppError> {
    let mut validation = Validation::new(jsonwebtoken::Algorithm::HS256);
    validation.validate_exp = true;
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map(|d| d.claims)
    .map_err(|_| AppError::Unauthorized)
}

/// The authenticated caller, attached to a live (non-revoked) account.
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub user_id: String,
    pub is_admin: bool,
}

/// Full validation: signature + expiry + the account still exists, is local
/// (federated shadows can't log in), and the token predates no password change.
/// This is the single auth path for REST **and** WS.
pub async fn validate_token(state: &AppState, token: &str) -> Result<AuthUser, AppError> {
    let claims = verify_token(&state.config.jwt_secret, token)?;

    let row: Option<(bool, DateTime<Utc>, bool)> = sqlx::query_as(
        "SELECT is_admin, password_changed_at, is_federated FROM users WHERE id = $1",
    )
    .bind(&claims.sub)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "auth lookup failed");
        AppError::Unauthorized // fail closed
    })?;

    let Some((is_admin, password_changed_at, is_federated)) = row else {
        return Err(AppError::Unauthorized);
    };
    if is_federated {
        return Err(AppError::Unauthorized);
    }
    if claims.iat < password_changed_at.timestamp() {
        // Token issued before the last password change: revoked.
        return Err(AppError::Unauthorized);
    }
    Ok(AuthUser {
        user_id: claims.sub,
        // Trust the DB, not the token, for the current admin bit.
        is_admin,
    })
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::Unauthorized)?;
        let token = header.strip_prefix("Bearer ").ok_or(AppError::Unauthorized)?;
        validate_token(state, token).await
    }
}
