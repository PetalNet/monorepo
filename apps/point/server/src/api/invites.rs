//! Server-level registration invites + the admin info endpoint. Admin-only.

use axum::extract::{Path, State};
use axum::Json;
use chrono::{DateTime, Duration, Utc};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;

fn require_admin(user: &AuthUser) -> ApiResult<()> {
    if user.is_admin {
        Ok(())
    } else {
        Err(AppError::Forbidden)
    }
}

#[derive(Deserialize)]
pub struct CreateInviteBody {
    pub max_uses: Option<i32>,
    pub expires_in_hours: Option<i64>,
}

pub async fn create_invite(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<CreateInviteBody>,
) -> ApiResult<Json<Value>> {
    require_admin(&user)?;

    let max_uses = body.max_uses.unwrap_or(1);
    if !(1..=10_000).contains(&max_uses) {
        return Err(AppError::BadRequest("max_uses must be 1-10000".into()));
    }
    let expires_at = match body.expires_in_hours {
        Some(h) if (1..=24 * 365).contains(&h) => Some(Utc::now() + Duration::hours(h)),
        Some(_) => {
            return Err(AppError::BadRequest(
                "expires_in_hours must be 1-8760".into(),
            ))
        }
        None => None,
    };

    let code = generate_invite_code();
    let (id,): (Uuid,) = sqlx::query_as(
        "INSERT INTO invites (code, created_by, max_uses, expires_at) VALUES ($1, $2, $3, $4)
         RETURNING id",
    )
    .bind(&code)
    .bind(&user.user_id)
    .bind(max_uses)
    .bind(expires_at)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(json!({
        "id": id,
        "code": code,
        "max_uses": max_uses,
        "expires_at": expires_at,
    })))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct InviteRow {
    pub id: Uuid,
    pub code: String,
    pub created_by: String,
    pub max_uses: i32,
    pub uses: i32,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

pub async fn list_invites(
    State(state): State<AppState>,
    user: AuthUser,
) -> ApiResult<Json<Vec<InviteRow>>> {
    require_admin(&user)?;
    let invites = sqlx::query_as::<_, InviteRow>(
        "SELECT id, code, created_by, max_uses, uses, expires_at, created_at
         FROM invites ORDER BY created_at DESC",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(invites))
}

pub async fn delete_invite(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    require_admin(&user)?;
    let result = sqlx::query("DELETE FROM invites WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn admin_info(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    require_admin(&user)?;
    let (user_count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users")
        .fetch_one(&state.pool)
        .await?;
    Ok(Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "domain": state.config.domain,
        "user_count": user_count,
        "open_registration": state.config.open_registration,
    })))
}

/// 8 chars of RFC-4648 base32 — unambiguous, easy to read aloud, 2^40 space.
fn generate_invite_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut rng = rand::thread_rng();
    (0..8)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}
