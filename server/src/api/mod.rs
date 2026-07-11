//! REST + WS router. All `/api/*` routes require a Bearer JWT via the
//! `AuthUser` extractor except register/login. `/.well-known/*` and the
//! federation inbox (M3) are unauthenticated by design.

use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .with_state(state)
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true }))
}
