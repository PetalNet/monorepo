//! The fail-closed authorization gate (spec §02, DECISIONS D-005).
//!
//! Every delivery decision goes through this module. The rules, in order:
//!
//! 1. **Ghost wins.** If the sender has the global ghost kill-switch on, or has
//!    per-target-ghosted the recipient, nothing is delivered. Server-enforced.
//! 2. **Explicit, current relationship required**: an accepted permanent share
//!    (`user_shares`), an active (unexpired) temporary share from sender to
//!    recipient, or — for group traffic — sender being a member of the group
//!    with their `sharing` flag on.
//! 3. **Errors deny.** Any DB error propagates as `Err`; callers must treat
//!    `Err` as "do not deliver", never as "assume yes".
//!
//! Legacy enforced only (parts of) rule 2's first clause; the gaps (temp shares
//! never consulted, group membership unchecked, no per-target ghost) are closed
//! here — see docs/legacy/server-map.md §2.

use sqlx::PgPool;

/// May a live fix from `sender` be delivered to `recipient` (user-addressed)?
///
/// `sender == recipient` is always allowed: your own devices seeing your own
/// data is not a sharing relationship, and ghost never hides you from yourself.
pub async fn can_deliver_to_user(
    pool: &PgPool,
    sender: &str,
    recipient: &str,
) -> Result<bool, sqlx::Error> {
    if sender == recipient {
        return Ok(true);
    }
    if is_ghost_blocked(pool, sender, recipient).await? {
        return Ok(false);
    }
    if has_user_share(pool, sender, recipient).await? {
        return Ok(true);
    }
    has_active_temp_share(pool, sender, recipient).await
}

/// The set of group members a fix from `sender` may fan out to.
///
/// Empty unless: sender is a member of the group AND sender's `sharing` flag is
/// on AND sender is not globally ghosted. Members the sender has per-target
/// ghosted are filtered out. Sender is excluded (delivery to the sender's own
/// devices is handled by the hub, not the share fan-out).
pub async fn group_fanout_recipients(
    pool: &PgPool,
    sender: &str,
    group_id: &str,
) -> Result<Vec<String>, sqlx::Error> {
    if is_globally_ghosted(pool, sender).await? {
        return Ok(Vec::new());
    }
    let sender_is_broadcasting_member: Option<(bool,)> = sqlx::query_as(
        "SELECT sharing FROM group_members WHERE group_id = $1::uuid AND user_id = $2",
    )
    .bind(group_id)
    .bind(sender)
    .fetch_optional(pool)
    .await?;
    match sender_is_broadcasting_member {
        Some((true,)) => {}
        _ => return Ok(Vec::new()), // not a member, or member chose not to broadcast
    }

    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT gm.user_id FROM group_members gm
         WHERE gm.group_id = $1::uuid
           AND gm.user_id <> $2
           AND NOT EXISTS (
               SELECT 1 FROM ghost_targets gt
               WHERE gt.user_id = $2 AND gt.target_user_id = gm.user_id
           )",
    )
    .bind(group_id)
    .bind(sender)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(u,)| u).collect())
}

/// May `viewer` read `target`'s data (history, current fixes)?
///
/// Requires a current relationship (accepted share, active temp share from
/// target to viewer, or a shared group where the target broadcasts), and the
/// target must not be ghosting the viewer (globally or per-target). Reading
/// your own data is always allowed.
pub async fn can_view(pool: &PgPool, viewer: &str, target: &str) -> Result<bool, sqlx::Error> {
    if viewer == target {
        return Ok(true);
    }
    if is_ghost_blocked(pool, target, viewer).await? {
        return Ok(false);
    }
    if has_user_share(pool, viewer, target).await? {
        return Ok(true);
    }
    if has_active_temp_share(pool, target, viewer).await? {
        return Ok(true);
    }
    shares_group_with_target_broadcasting(pool, viewer, target).await
}

/// May `requester` fetch `target`'s MLS KeyPackages (to add them to a group)?
///
/// KeyPackages are public-key material, not location data, so ghost does not
/// gate them — but a *consented* relationship is required. We deliberately do
/// NOT grant on a bare pending share request: a pending request is unilateral
/// (anyone can send one to any user), so honoring it would let an unconsented
/// stranger drain the target's one-time KeyPackage pool — forcing every real
/// group-add onto the single last-resort package and downgrading forward
/// secrecy (the D-007 failure mode, reintroduced via authz). The MLS group for
/// a direct share is formed at accept time, by which point an accepted
/// `user_shares` row exists, so the accept flow still has what it needs.
/// Allowed: accepted share, active temp share in either direction, or a shared
/// group.
pub async fn can_fetch_key_packages(
    pool: &PgPool,
    requester: &str,
    target: &str,
) -> Result<bool, sqlx::Error> {
    if requester == target {
        return Ok(true);
    }
    if has_user_share(pool, requester, target).await? {
        return Ok(true);
    }
    if has_active_temp_share(pool, requester, target).await?
        || has_active_temp_share(pool, target, requester).await?
    {
        return Ok(true);
    }
    shares_any_group(pool, requester, target).await
}

// ---------------------------------------------------------------------------
// building blocks
// ---------------------------------------------------------------------------

pub async fn is_globally_ghosted(pool: &PgPool, user: &str) -> Result<bool, sqlx::Error> {
    let row: Option<(bool,)> = sqlx::query_as("SELECT ghost_active FROM users WHERE id = $1")
        .bind(user)
        .fetch_optional(pool)
        .await?;
    // Unknown sender = fail closed (treat as ghosted/undeliverable).
    Ok(row.map(|(g,)| g).unwrap_or(true))
}

/// Ghost check for a (sender, recipient) pair: global kill-switch or per-target.
async fn is_ghost_blocked(
    pool: &PgPool,
    sender: &str,
    recipient: &str,
) -> Result<bool, sqlx::Error> {
    if is_globally_ghosted(pool, sender).await? {
        return Ok(true);
    }
    let row: Option<(i32,)> =
        sqlx::query_as("SELECT 1 FROM ghost_targets WHERE user_id = $1 AND target_user_id = $2")
            .bind(sender)
            .bind(recipient)
            .fetch_optional(pool)
            .await?;
    Ok(row.is_some())
}

async fn has_user_share(pool: &PgPool, a: &str, b: &str) -> Result<bool, sqlx::Error> {
    // Byte-exact ordering, matching the `COLLATE "C"` CHECK on user_shares — a
    // Rust `<` on &str is a bytewise compare, so this and the stored canonical
    // order always agree regardless of the database's default collation (D-016).
    let (lo, hi) = if a < b { (a, b) } else { (b, a) };
    let row: Option<(i32,)> =
        sqlx::query_as("SELECT 1 FROM user_shares WHERE user_a = $1 AND user_b = $2")
            .bind(lo)
            .bind(hi)
            .fetch_optional(pool)
            .await?;
    Ok(row.is_some())
}

async fn has_active_temp_share(pool: &PgPool, from: &str, to: &str) -> Result<bool, sqlx::Error> {
    let row: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM temporary_shares
         WHERE from_user_id = $1 AND to_user_id = $2 AND expires_at > now()
         LIMIT 1",
    )
    .bind(from)
    .bind(to)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

async fn shares_any_group(pool: &PgPool, a: &str, b: &str) -> Result<bool, sqlx::Error> {
    let row: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM group_members ga
         JOIN group_members gb ON ga.group_id = gb.group_id
         WHERE ga.user_id = $1 AND gb.user_id = $2
         LIMIT 1",
    )
    .bind(a)
    .bind(b)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

/// Viewer and target share a group in which the target has `sharing` on —
/// i.e. the target is actually broadcasting into a group the viewer is in.
async fn shares_group_with_target_broadcasting(
    pool: &PgPool,
    viewer: &str,
    target: &str,
) -> Result<bool, sqlx::Error> {
    let row: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM group_members gv
         JOIN group_members gt ON gv.group_id = gt.group_id
         WHERE gv.user_id = $1 AND gt.user_id = $2 AND gt.sharing
         LIMIT 1",
    )
    .bind(viewer)
    .bind(target)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

/// May `requester` view `target`'s profile surface (today: the avatar)?
///
/// Everything `can_fetch_key_packages` allows, plus a PENDING share request
/// in either direction: you get to see who is asking before you answer, and
/// the person you asked can see you while deciding. Fail-closed like every
/// gate in this module.
pub async fn can_view_profile(
    pool: &PgPool,
    requester: &str,
    target: &str,
) -> Result<bool, sqlx::Error> {
    if can_fetch_key_packages(pool, requester, target).await? {
        return Ok(true);
    }
    let pending: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM share_requests
         WHERE ((from_user_id = $1 AND to_user_id = $2)
             OR (from_user_id = $2 AND to_user_id = $1))
           AND status = 'pending'
         LIMIT 1",
    )
    .bind(requester)
    .bind(target)
    .fetch_optional(pool)
    .await?;
    Ok(pending.is_some())
}
