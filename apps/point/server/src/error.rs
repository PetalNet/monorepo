//! Application error type. Client-facing messages stay generic; details go to
//! logs/Glitchtip. Fail closed: unexpected errors become 500s, never silent
//! success.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug)]
pub enum AppError {
    BadRequest(String),
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict(String),
    TooManyRequests,
    Internal(String),
}

pub type ApiResult<T> = Result<T, AppError>;

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        if let sqlx::Error::Database(db) = &e {
            // Postgres unique violation -> 409, matching legacy behavior.
            if db.code().as_deref() == Some("23505") {
                return AppError::Conflict("already exists".into());
            }
        }
        tracing::error!(error = %e, "database error");
        AppError::Internal("database error".into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized".into()),
            AppError::Forbidden => (StatusCode::FORBIDDEN, "forbidden".into()),
            AppError::NotFound => (StatusCode::NOT_FOUND, "not found".into()),
            AppError::Conflict(m) => (StatusCode::CONFLICT, m),
            AppError::TooManyRequests => {
                (StatusCode::TOO_MANY_REQUESTS, "rate limit exceeded".into())
            }
            AppError::Internal(m) => {
                tracing::error!("internal error: {m}");
                sentry::capture_message(&m, sentry::Level::Error);
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error".into())
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}
