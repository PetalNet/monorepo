//! Groups: create/list/inspect, settings, membership, invites, roles
//! (docs/legacy/server-map.md §7; enforcement per DECISIONS D-005).
//!
//! Visibility is enumeration-safe: a group you are not a member of answers 404
//! exactly like a group that does not exist. Inside a group, role failures are
//! honest 403s — members already know the group exists.

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

use super::auth::sanitize_display_name;
use super::invites::generate_invite_code;
use super::rate_limit::RateLimiter;
use super::shares::validate_precision;

/// Join-by-code attempts per minute, per calling user (code brute-force guard).
const GROUP_JOIN_PER_MINUTE: u32 = 5;

/// Group names get the same sanitizer as display names (they render in client
/// UI next to location data — same spoofing surface), 1..=64 chars.
fn validate_group_name(raw: &str) -> Result<String, AppError> {
    let name = sanitize_display_name(raw);
    if name.is_empty() {
        return Err(AppError::BadRequest("group name must be 1-64 chars".into()));
    }
    Ok(name)
}

/// The caller's membership row, or None (fail-closed callers map None -> 404).
async fn membership(
    state: &AppState,
    group_id: Uuid,
    user_id: &str,
) -> Result<Option<(String, String)>, sqlx::Error> {
    // (role, owner_id) so callers get "am I admin" and "am I owner" in one hit.
    sqlx::query_as(
        "SELECT gm.role, g.owner_id FROM group_members gm
         JOIN groups g ON g.id = gm.group_id
         WHERE gm.group_id = $1 AND gm.user_id = $2",
    )
    .bind(group_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await
}

// ---------------------------------------------------------------------------
// create / list / inspect / delete
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct CreateGroupBody {
    pub name: String,
}

/// POST /api/groups — creator becomes an admin member in the same transaction.
pub async fn create_group(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<CreateGroupBody>,
) -> ApiResult<Json<Value>> {
    let name = validate_group_name(&body.name)?;
    let mut tx = state.pool.begin().await?;
    let (id,): (Uuid,) =
        sqlx::query_as("INSERT INTO groups (name, owner_id) VALUES ($1, $2) RETURNING id")
            .bind(&name)
            .bind(&user.user_id)
            .fetch_one(&mut *tx)
            .await?;
    sqlx::query("INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'admin')")
        .bind(id)
        .bind(&user.user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({ "id": id, "name": name })))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct MyGroupRow {
    pub id: Uuid,
    pub name: String,
    pub owner_id: String,
    pub members_can_invite: bool,
    pub role: String,
    pub sharing: bool,
    pub precision: String,
    pub member_count: i64,
    pub created_at: DateTime<Utc>,
}

/// GET /api/groups — my groups, with member count and my membership settings.
pub async fn list_groups(
    State(state): State<AppState>,
    user: AuthUser,
) -> ApiResult<Json<Vec<MyGroupRow>>> {
    let rows = sqlx::query_as::<_, MyGroupRow>(
        "SELECT g.id, g.name, g.owner_id, g.members_can_invite, gm.role, gm.sharing,
                gm.precision, g.created_at,
                (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count
         FROM groups g
         JOIN group_members gm ON gm.group_id = g.id
         WHERE gm.user_id = $1
         ORDER BY g.created_at DESC",
    )
    .bind(&user.user_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct MemberRow {
    pub user_id: String,
    pub display_name: String,
    pub role: String,
    pub sharing: bool,
    pub joined_at: DateTime<Utc>,
}

/// GET /api/groups/{id} — members list, member-only (non-members get the same
/// 404 as a nonexistent group).
pub async fn get_group(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    if membership(&state, id, &user.user_id).await?.is_none() {
        return Err(AppError::NotFound);
    }
    let group: Option<(String, String, bool, DateTime<Utc>)> = sqlx::query_as(
        "SELECT name, owner_id, members_can_invite, created_at FROM groups WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await?;
    let Some((name, owner_id, members_can_invite, created_at)) = group else {
        return Err(AppError::NotFound); // deleted mid-request
    };
    let members = sqlx::query_as::<_, MemberRow>(
        "SELECT gm.user_id, u.display_name, gm.role, gm.sharing, gm.joined_at
         FROM group_members gm
         JOIN users u ON u.id = gm.user_id
         WHERE gm.group_id = $1
         ORDER BY gm.joined_at ASC",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!({
        "id": id,
        "name": name,
        "owner_id": owner_id,
        "members_can_invite": members_can_invite,
        "created_at": created_at,
        "members": members,
    })))
}

/// DELETE /api/groups/{id} — owner only.
pub async fn delete_group(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let Some((_, owner_id)) = membership(&state, id, &user.user_id).await? else {
        return Err(AppError::NotFound);
    };
    if owner_id != user.user_id {
        return Err(AppError::Forbidden);
    }
    // Members, invites cascade (schema FKs).
    sqlx::query("DELETE FROM groups WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// settings / my membership
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct GroupSettingsBody {
    pub name: Option<String>,
    pub members_can_invite: Option<bool>,
}

/// PUT /api/groups/{id}/settings — admin only.
pub async fn update_settings(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<GroupSettingsBody>,
) -> ApiResult<Json<Value>> {
    let Some((role, _)) = membership(&state, id, &user.user_id).await? else {
        return Err(AppError::NotFound);
    };
    if role != "admin" {
        return Err(AppError::Forbidden);
    }
    let name = body.name.as_deref().map(validate_group_name).transpose()?;
    sqlx::query(
        "UPDATE groups SET name = COALESCE($2, name),
                           members_can_invite = COALESCE($3, members_can_invite)
         WHERE id = $1",
    )
    .bind(id)
    .bind(&name)
    .bind(body.members_can_invite)
    .execute(&state.pool)
    .await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct MyMembershipBody {
    pub sharing: Option<bool>,
    pub precision: Option<String>,
}

/// PUT /api/groups/{id}/me — my own membership row (broadcast opt-in/out and
/// precision hint). `sharing=false` is enforced server-side on fan-out (D-005).
pub async fn update_my_membership(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<MyMembershipBody>,
) -> ApiResult<Json<Value>> {
    let precision = body
        .precision
        .as_deref()
        .map(|p| validate_precision(Some(p)))
        .transpose()?;
    let result = sqlx::query(
        "UPDATE group_members SET sharing = COALESCE($3, sharing),
                                  precision = COALESCE($4, precision)
         WHERE group_id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(&user.user_id)
    .bind(body.sharing)
    .bind(&precision)
    .execute(&state.pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound); // not a member == group doesn't exist for you
    }
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// invites / join
// ---------------------------------------------------------------------------

/// Admins always may invite; plain members only when the group allows it.
async fn can_invite(state: &AppState, group_id: Uuid, user_id: &str) -> ApiResult<()> {
    let Some((role, _)) = membership(state, group_id, user_id).await? else {
        return Err(AppError::NotFound);
    };
    if role == "admin" {
        return Ok(());
    }
    let (members_can_invite,): (bool,) =
        sqlx::query_as("SELECT members_can_invite FROM groups WHERE id = $1")
            .bind(group_id)
            .fetch_one(&state.pool)
            .await?;
    if members_can_invite {
        Ok(())
    } else {
        Err(AppError::Forbidden)
    }
}

#[derive(Deserialize)]
pub struct GroupInviteBody {
    pub max_uses: Option<i32>,
    pub expires_in_hours: Option<i64>,
}

/// POST /api/groups/{id}/invite — admin, or member when members_can_invite.
pub async fn create_group_invite(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<GroupInviteBody>,
) -> ApiResult<Json<Value>> {
    can_invite(&state, id, &user.user_id).await?;

    let max_uses = body.max_uses.unwrap_or(0); // schema: 0 = unlimited
    if !(0..=10_000).contains(&max_uses) {
        return Err(AppError::BadRequest("max_uses must be 0-10000".into()));
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
    let (invite_id,): (Uuid,) = sqlx::query_as(
        "INSERT INTO group_invites (group_id, code, created_by, max_uses, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id",
    )
    .bind(id)
    .bind(&code)
    .bind(&user.user_id)
    .bind(max_uses)
    .bind(expires_at)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(json!({
        "id": invite_id,
        "code": code,
        "max_uses": max_uses,
        "expires_at": expires_at,
    })))
}

/// POST /api/groups/join/{code} — atomic use-count claim (same pattern as
/// registration invites): expired/exhausted/unknown codes all match zero rows
/// and answer the same generic 400.
pub async fn join_by_code(
    State(state): State<AppState>,
    Extension(limiter): Extension<Arc<RateLimiter>>,
    user: AuthUser,
    Path(code): Path<String>,
) -> ApiResult<Json<Value>> {
    limiter.check(
        &format!("group_join:{}", user.user_id),
        GROUP_JOIN_PER_MINUTE,
    )?;

    let code = code.trim().to_uppercase();
    let mut tx = state.pool.begin().await?;
    let claimed: Option<(Uuid,)> = sqlx::query_as(
        "UPDATE group_invites SET uses = uses + 1
         WHERE code = $1
           AND (max_uses = 0 OR uses < max_uses)
           AND (expires_at IS NULL OR expires_at > now())
         RETURNING group_id",
    )
    .bind(&code)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((group_id,)) = claimed else {
        return Err(AppError::BadRequest("invalid invite".into()));
    };
    let inserted = sqlx::query(
        "INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)
         ON CONFLICT (group_id, user_id) DO NOTHING",
    )
    .bind(group_id)
    .bind(&user.user_id)
    .execute(&mut *tx)
    .await?;
    if inserted.rows_affected() == 0 {
        // Already a member: idempotent success, and the dropped transaction
        // rolls the use-count claim back so re-joins don't burn invite uses.
        return Ok(Json(json!({ "ok": true, "group_id": group_id })));
    }
    tx.commit().await?;
    Ok(Json(json!({ "ok": true, "group_id": group_id })))
}

// ---------------------------------------------------------------------------
// direct membership management
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct AddMemberBody {
    pub user_id: String,
}

/// POST /api/groups/{id}/members — add a member directly: admin, or member
/// when members_can_invite.
///
/// Privacy rule: the target must already have an accepted user_share with the
/// ADDER. Direct-add bypasses the target's own consent step (no invite code
/// they chose to redeem), so it is limited to people who have already
/// established mutual sharing with the adder — you can never pull a stranger
/// (or enumerate one) into a group. Nonexistent target and no-share target
/// answer the same generic 400.
pub async fn add_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<AddMemberBody>,
) -> ApiResult<Json<Value>> {
    can_invite(&state, id, &user.user_id).await?;

    let target = body.user_id.trim().to_lowercase();
    if target.is_empty() || target == user.user_id {
        return Err(AppError::BadRequest("invalid target".into()));
    }
    let (lo, hi) = if user.user_id < target {
        (&user.user_id, &target)
    } else {
        (&target, &user.user_id)
    };
    let share: Option<(i32,)> =
        sqlx::query_as("SELECT 1 FROM user_shares WHERE user_a = $1 AND user_b = $2")
            .bind(lo)
            .bind(hi)
            .fetch_optional(&state.pool)
            .await?;
    if share.is_none() {
        return Err(AppError::BadRequest("cannot add this user".into()));
    }
    // Already a member: idempotent success.
    sqlx::query(
        "INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)
         ON CONFLICT (group_id, user_id) DO NOTHING",
    )
    .bind(id)
    .bind(&target)
    .execute(&state.pool)
    .await?;

    let notify = json!({ "type": "group.member_added", "group_id": id }).to_string();
    state.hub.send_to_user(&target, &notify);
    Ok(Json(json!({ "ok": true })))
}

/// DELETE /api/groups/{id}/members/{user_id} — self (leave) or admin (kick).
/// The owner cannot be kicked, and cannot leave while other members remain
/// (delete the group or transfer ownership first — v1 has no transfer, so:
/// delete). An owner leaving an otherwise-empty group deletes it.
pub async fn remove_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, target)): Path<(Uuid, String)>,
) -> ApiResult<Json<Value>> {
    let Some((actor_role, owner_id)) = membership(&state, id, &user.user_id).await? else {
        return Err(AppError::NotFound);
    };
    let is_self = target == user.user_id;
    if !is_self && actor_role != "admin" {
        return Err(AppError::Forbidden);
    }

    if target == owner_id {
        if !is_self {
            // Nobody kicks the owner, admin or not.
            return Err(AppError::Forbidden);
        }
        let (others,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM group_members WHERE group_id = $1 AND user_id <> $2",
        )
        .bind(id)
        .bind(&target)
        .fetch_one(&state.pool)
        .await?;
        if others > 0 {
            return Err(AppError::BadRequest(
                "the owner cannot leave a group with other members: delete the group instead"
                    .into(),
            ));
        }
        // Last member out: remove the group itself (memberships cascade).
        sqlx::query("DELETE FROM groups WHERE id = $1")
            .bind(id)
            .execute(&state.pool)
            .await?;
        return Ok(Json(json!({ "ok": true })));
    }

    let result = sqlx::query("DELETE FROM group_members WHERE group_id = $1 AND user_id = $2")
        .bind(id)
        .bind(&target)
        .execute(&state.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct SetRoleBody {
    pub role: String,
}

/// PUT /api/groups/{id}/members/{user_id}/role — admin only. The owner's admin
/// role is fixed (demoting the owner would orphan group administration).
pub async fn set_member_role(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, target)): Path<(Uuid, String)>,
    Json(body): Json<SetRoleBody>,
) -> ApiResult<Json<Value>> {
    let Some((actor_role, owner_id)) = membership(&state, id, &user.user_id).await? else {
        return Err(AppError::NotFound);
    };
    if actor_role != "admin" {
        return Err(AppError::Forbidden);
    }
    if !matches!(body.role.as_str(), "member" | "admin") {
        return Err(AppError::BadRequest("role must be member or admin".into()));
    }
    if target == owner_id {
        return Err(AppError::BadRequest(
            "the owner's role cannot change".into(),
        ));
    }
    let result =
        sqlx::query("UPDATE group_members SET role = $3 WHERE group_id = $1 AND user_id = $2")
            .bind(id)
            .bind(&target)
            .bind(&body.role)
            .execute(&state.pool)
            .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}
