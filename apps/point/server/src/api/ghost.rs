//! Ghost mode: the global kill-switch (`users.ghost_active`) plus the
//! per-target set (`ghost_targets`). Both are enforced server-side in the
//! authz gate (D-005); these endpoints are only the state surface. The v1
//! client exposes the global toggle; per-target is the enforcement slot.

use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct SetGhostBody {
    pub active: bool,
}

/// PUT /api/ghost — flip the global kill-switch.
pub async fn set_ghost(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<SetGhostBody>,
) -> ApiResult<Json<Value>> {
    let result =
        sqlx::query("UPDATE users SET ghost_active = $1, updated_at = now() WHERE id = $2")
            .bind(body.active)
            .bind(&user.user_id)
            .execute(&state.pool)
            .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::Unauthorized); // mid-request account deletion
    }
    Ok(Json(json!({ "active": body.active })))
}

/// GET /api/ghost — current global flag + per-target set.
pub async fn get_ghost(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    let row: Option<(bool,)> = sqlx::query_as("SELECT ghost_active FROM users WHERE id = $1")
        .bind(&user.user_id)
        .fetch_optional(&state.pool)
        .await?;
    let Some((active,)) = row else {
        return Err(AppError::Unauthorized);
    };
    let targets: Vec<(String,)> = sqlx::query_as(
        "SELECT target_user_id FROM ghost_targets WHERE user_id = $1 ORDER BY created_at",
    )
    .bind(&user.user_id)
    .fetch_all(&state.pool)
    .await?;
    let targets: Vec<String> = targets.into_iter().map(|(t,)| t).collect();
    Ok(Json(json!({ "active": active, "targets": targets })))
}

#[derive(Deserialize)]
pub struct GhostTargetBody {
    pub user_id: String,
    pub ghosted: bool,
}

/// PUT /api/ghost/targets — add/remove one per-target ghost entry.
/// Enumeration-safe: ghosting a nonexistent user is a silent no-op with the
/// same success shape (the FK would otherwise turn probes into 500s).
pub async fn set_ghost_target(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<GhostTargetBody>,
) -> ApiResult<Json<Value>> {
    let target = body.user_id.trim().to_lowercase();
    if target.is_empty() || target == user.user_id {
        return Err(AppError::BadRequest("invalid target".into()));
    }
    if body.ghosted {
        sqlx::query(
            "INSERT INTO ghost_targets (user_id, target_user_id)
             SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM users WHERE id = $2)
             ON CONFLICT (user_id, target_user_id) DO NOTHING",
        )
        .bind(&user.user_id)
        .bind(&target)
        .execute(&state.pool)
        .await?;
    } else {
        sqlx::query("DELETE FROM ghost_targets WHERE user_id = $1 AND target_user_id = $2")
            .bind(&user.user_id)
            .bind(&target)
            .execute(&state.pool)
            .await?;
    }
    Ok(Json(json!({ "user_id": target, "ghosted": body.ghosted })))
}
