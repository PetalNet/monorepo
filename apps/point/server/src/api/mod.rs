//! REST + WS router. All `/api/*` routes require a Bearer JWT via the
//! `AuthUser` extractor except register/login (and the OIDC pair, which mint
//! the JWT). `/.well-known/*` and the federation inbox (M3) are
//! unauthenticated by design.

pub mod account;
pub mod auth;
pub mod ghost;
pub mod groups;
pub mod history;
pub mod invites;
pub mod mls;
pub mod oidc;
pub mod rate_limit;
pub mod shares;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_sharing;
#[cfg(test)]
mod tests_ws_mls;

use std::sync::Arc;

use axum::routing::{delete, get, post, put};
use axum::{Extension, Json, Router};
use serde_json::{json, Value};

use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    // One limiter per router: per-process in production, per-instance in tests.
    let limiter = Arc::new(rate_limit::RateLimiter::default());

    let mut router = Router::new()
        .route("/health", get(health))
        .route("/api/register", post(auth::register))
        .route("/api/login", post(auth::login))
        .route("/api/me", get(account::me))
        .route("/api/account", delete(account::delete_account))
        .route("/api/account/password", put(account::change_password))
        .route("/api/fcm/token", post(account::register_fcm_token))
        .route(
            "/api/invites",
            post(invites::create_invite).get(invites::list_invites),
        )
        .route("/api/invites/{id}", delete(invites::delete_invite))
        .route("/api/admin/info", get(invites::admin_info))
        // shares
        .route("/api/shares", get(shares::list_shares))
        .route("/api/shares/request", post(shares::create_request))
        .route("/api/shares/requests", get(shares::incoming_requests))
        .route(
            "/api/shares/requests/outgoing",
            get(shares::outgoing_requests),
        )
        .route(
            "/api/shares/requests/{id}/accept",
            post(shares::accept_request),
        )
        .route(
            "/api/shares/requests/{id}/reject",
            post(shares::reject_request),
        )
        .route(
            "/api/shares/temp",
            post(shares::create_temp).get(shares::list_temp),
        )
        .route("/api/shares/temp/{id}", delete(shares::delete_temp))
        .route("/api/shares/{user_id}", delete(shares::delete_share))
        // groups
        .route(
            "/api/groups",
            post(groups::create_group).get(groups::list_groups),
        )
        .route("/api/groups/join/{code}", post(groups::join_by_code))
        .route(
            "/api/groups/{id}",
            get(groups::get_group).delete(groups::delete_group),
        )
        .route("/api/groups/{id}/settings", put(groups::update_settings))
        .route("/api/groups/{id}/me", put(groups::update_my_membership))
        .route("/api/groups/{id}/invite", post(groups::create_group_invite))
        .route("/api/groups/{id}/members", post(groups::add_member))
        .route(
            "/api/groups/{id}/members/{user_id}",
            delete(groups::remove_member),
        )
        .route(
            "/api/groups/{id}/members/{user_id}/role",
            put(groups::set_member_role),
        )
        // ghost
        .route("/api/ghost", put(ghost::set_ghost).get(ghost::get_ghost))
        .route("/api/ghost/targets", put(ghost::set_ghost_target))
        // history
        .route("/api/history", delete(history::delete_my_history))
        .route("/api/history/{user_id}", get(history::get_history))
        // MLS delivery service (ciphertext-only)
        .route("/api/mls/keys", post(mls::upload_keys))
        .route("/api/mls/keys/count", get(mls::key_count))
        // GET is a non-consuming probe; POST .../claim atomically consumes one.
        .route("/api/mls/keys/{user_id}", get(mls::probe_key))
        .route("/api/mls/keys/{user_id}/claim", post(mls::claim_key))
        .route("/api/mls/welcome", post(mls::send_welcome))
        .route("/api/mls/commit", post(mls::send_commit))
        .route("/api/mls/messages", get(mls::pending_messages))
        .route("/api/mls/messages/{id}/ack", post(mls::ack_message))
        // live location stream (auth is the first WS message, D-011)
        .route("/ws", get(crate::ws::ws_handler));

    // OIDC routes exist only when configured (decision 17): otherwise 404.
    if state.config.oidc.is_some() {
        router = router
            .route("/api/oidc/login", get(oidc::login))
            .route("/api/oidc/callback", get(oidc::callback));
    }

    let trust_proxy = rate_limit::TrustProxy(state.config.trusted_proxy);
    router
        .layer(Extension(trust_proxy))
        .layer(Extension(limiter))
        .with_state(state)
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true }))
}
