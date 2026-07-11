//! REST + WS router. All `/api/*` routes require a Bearer JWT via the
//! `AuthUser` extractor except register/login (and the OIDC pair, which mint
//! the JWT). `/.well-known/*` and the federation inbox (M3) are
//! unauthenticated by design.

pub mod account;
pub mod auth;
pub mod invites;
pub mod oidc;
pub mod rate_limit;

#[cfg(test)]
mod tests;

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
        .route("/api/admin/info", get(invites::admin_info));

    // OIDC routes exist only when configured (decision 17): otherwise 404.
    if state.config.oidc.is_some() {
        router = router
            .route("/api/oidc/login", get(oidc::login))
            .route("/api/oidc/callback", get(oidc::callback));
    }

    router.layer(Extension(limiter)).with_state(state)
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true }))
}
